#!/usr/bin/env python3
"""Genuine OMEMO 2 backend for the OpenClaw XMPP plugin.

The persistent process speaks newline-delimited JSON over stdin/stdout.  It
owns all OMEMO 2 identity, X3DH and Double Ratchet state; Node only performs
the XMPP PEP operations requested through callbacks.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

from omemo import SessionManager, TrustLevel, JSONType, Maybe, Just, Nothing
from omemo.storage import Storage
from omemo.types import DeviceInformation
from twomemo import Twomemo
from twomemo.etree import (
    parse_bundle,
    parse_device_list,
    parse_message,
    serialize_bundle,
    serialize_device_list,
    serialize_message,
)

NAMESPACE = "urn:xmpp:omemo:2"


class JsonStorage(Storage):
    def __init__(self, path: Path):
        super().__init__()
        self.path = path
        self.data: dict[str, Any] = {}
        if path.exists():
            os.chmod(path, 0o600)
            self.data = json.loads(path.read_text(encoding="utf-8"))

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        with tmp.open("w", encoding="utf-8") as handle:
            json.dump(self.data, handle, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, 0o600)
        tmp.replace(self.path)
        directory = os.open(self.path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    async def _load(self, key: str) -> Maybe[JSONType]:
        if key in self.data:
            return Just(self.data[key])
        return Nothing()

    async def _store(self, key: str, value: JSONType) -> None:
        self.data[key] = value
        self._save()

    async def _delete(self, key: str) -> None:
        self.data.pop(key, None)
        self._save()


class Rpc:
    def __init__(self):
        self.counter = 0

    def send(self, payload: dict[str, Any]) -> None:
        sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
        sys.stdout.flush()

    async def callback(self, method: str, params: dict[str, Any]) -> Any:
        self.counter += 1
        callback_id = f"cb-{self.counter}"
        self.send({"type": "callback", "id": callback_id, "method": method, "params": params})
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            raise EOFError("Node bridge closed while callback was pending")
        response = json.loads(line)
        if response.get("id") != callback_id:
            raise RuntimeError(f"unexpected callback response: {response.get('id')}")
        if response.get("error"):
            raise RuntimeError(str(response["error"]))
        return response.get("result")


RPC = Rpc()


class OpenClawSessionManager(SessionManager):
    @staticmethod
    async def _upload_bundle(bundle) -> None:
        await RPC.callback("upload_bundle", {
            "namespace": NAMESPACE,
            "deviceId": bundle.device_id,
            "payload": ET.tostring(serialize_bundle(bundle), encoding="unicode"),
        })

    @staticmethod
    async def _download_bundle(namespace: str, bare_jid: str, device_id: int):
        payload = await RPC.callback("download_bundle", {
            "namespace": namespace,
            "jid": bare_jid,
            "deviceId": device_id,
        })
        return parse_bundle(ET.fromstring(payload), bare_jid, device_id)

    @staticmethod
    async def _delete_bundle(namespace: str, device_id: int) -> None:
        await RPC.callback("delete_bundle", {"namespace": namespace, "deviceId": device_id})

    @staticmethod
    async def _upload_device_list(namespace: str, device_list) -> None:
        await RPC.callback("upload_device_list", {
            "namespace": namespace,
            "payload": ET.tostring(serialize_device_list(device_list), encoding="unicode"),
        })

    @staticmethod
    async def _download_device_list(namespace: str, bare_jid: str):
        payload = await RPC.callback("download_device_list", {
            "namespace": namespace,
            "jid": bare_jid,
        })
        return parse_device_list(ET.fromstring(payload))

    async def _evaluate_custom_trust_level(self, device: DeviceInformation) -> TrustLevel:
        return TrustLevel.TRUSTED if device.trust_level_name == "trusted" else TrustLevel.UNDECIDED

    async def _make_trust_decision(self, undecided, identifier) -> None:
        for device in undecided:
            await self.set_trust(device.bare_jid, device.identity_key, "trusted")

    @staticmethod
    async def _send_message(message, bare_jid: str) -> None:
        await RPC.callback("send_message", {
            "jid": bare_jid,
            "payload": ET.tostring(serialize_message(message), encoding="unicode"),
        })


class Backend:
    def __init__(self, account_id: str, jid: str, state_dir: Path):
        self.account_id = account_id
        self.jid = jid
        safe_account_id = "".join(c if c.isalnum() or c in "._-" else "_" for c in account_id)
        if not safe_account_id:
            raise ValueError("accountId cannot be empty")
        self.storage = JsonStorage(state_dir / f"omemo2-{safe_account_id}.json")
        self.manager: OpenClawSessionManager | None = None

    async def initialize(self, label: str) -> dict[str, Any]:
        self.manager = await OpenClawSessionManager.create(
            backends=[Twomemo(self.storage)],
            storage=self.storage,
            own_bare_jid=self.jid,
            initial_own_label=label,
            undecided_trust_level_name="undecided",
        )
        await self.manager.after_history_sync()
        device_id = (await self.storage.load_primitive("/own_device_id", int)).from_just()
        return {"deviceId": device_id, "namespace": NAMESPACE}

    def _manager(self) -> OpenClawSessionManager:
        if self.manager is None:
            raise RuntimeError("OMEMO 2 backend is not initialized")
        return self.manager

    async def encrypt(self, jids: list[str], plaintext: str) -> dict[str, Any]:
        for jid in jids:
            await self._manager().refresh_device_list(NAMESPACE, jid)
        messages, errors = await self._manager().encrypt(
            frozenset(jids),
            {NAMESPACE: plaintext.encode("utf-8")},
            backend_priority_order=[NAMESPACE],
        )
        return {
            "messages": [ET.tostring(serialize_message(message), encoding="unicode") for message in messages],
            "errors": [str(error) for error in errors],
        }

    async def decrypt(self, jid: str, payload: str) -> dict[str, Any]:
        message = parse_message(ET.fromstring(payload), jid)
        plaintext, device, _key_material = await self._manager().decrypt(message)
        return {
            "plaintext": None if plaintext is None else base64.b64encode(plaintext).decode("ascii"),
            "senderDeviceId": device.device_id,
        }


async def main() -> None:
    backend: Backend | None = None
    while line := await asyncio.to_thread(sys.stdin.readline):
        request = json.loads(line)
        request_id = request.get("id")
        try:
            method = request["method"]
            params = request.get("params", {})
            if method == "initialize":
                backend = Backend(params["accountId"], params["jid"], Path(params["stateDir"]))
                result = await backend.initialize(params.get("label") or "OpenClaw")
            elif backend is None:
                raise RuntimeError("initialize must be called first")
            elif method == "encrypt":
                result = await backend.encrypt(params["jids"], params["plaintext"])
            elif method == "decrypt":
                result = await backend.decrypt(params["jid"], params["payload"])
            elif method == "shutdown":
                RPC.send({"type": "response", "id": request_id, "result": {"ok": True}})
                return
            else:
                raise ValueError(f"unknown method: {method}")
            RPC.send({"type": "response", "id": request_id, "result": result})
        except Exception as exc:
            RPC.send({"type": "response", "id": request_id, "error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    asyncio.run(main())
