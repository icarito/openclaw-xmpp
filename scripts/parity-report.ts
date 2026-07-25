#!/usr/bin/env node
// Reporte de paridad XMPP ↔ Telegram, ejecutable offline.
//
// No requiere red, servidor OpenClaw, cuenta XMPP ni cliente conectado: toda
// la información sale de node_modules/openclaw/dist (clavado por
// package-lock.json) y del propio checkout. Uso:
//
//   npx tsx scripts/parity-report.ts
//
import { buildParityReport, type ClassifiedCommand } from "../src/parity/analyze.js";

function printCommandGroup(title: string, commands: ClassifiedCommand[]): void {
  if (commands.length === 0) return;
  console.log(`\n${title} (${commands.length})`);
  for (const command of commands) {
    const tier = command.tier ?? "(sin tier)";
    const category = command.category ?? "(sin categoría)";
    const extra = command.status === "denied" ? `\n      → ${command.reason}` : "";
    console.log(`  ${command.name.padEnd(20)} tier=${tier.padEnd(10)} cat=${category}${extra}`);
  }
}

function main(): void {
  const report = buildParityReport();

  console.log("=== Cobertura de comandos nativos (registro del core) ===");
  console.log(
    `Total: ${report.commands.length}  ·  ` +
      `expuestos: ${report.counts.exposed}  ·  ` +
      `denegados: ${report.counts.denied}  ·  ` +
      `no aplican (otro provider): ${report.counts["not-applicable"]}  ·  ` +
      `SIN CLASIFICAR: ${report.counts.unclassified}`,
  );

  printCommandGroup("Expuestos por XMPP", report.commands.filter((c) => c.status === "exposed"));
  printCommandGroup(
    "No aplican (restringidos a otro provider)",
    report.commands.filter((c) => c.status === "not-applicable"),
  );
  printCommandGroup("Denegados (con motivo)", report.commands.filter((c) => c.status === "denied"));

  if (report.unclassified.length > 0) {
    console.log("\n⚠ COMANDOS SIN CLASIFICAR — requieren decisión antes del próximo release:");
    printCommandGroup("Sin clasificar", report.unclassified);
  }

  if (report.staleDenyEntries.length > 0) {
    console.log("\n⚠ Entradas de deny-list obsoletas (el comando ya no existe o ya está expuesto):");
    for (const name of report.staleDenyEntries) console.log(`  - ${name}`);
  }

  console.log("\n=== Propiedades de config declaradas en el manifiesto ===");
  console.log(
    `Telegram: ${report.config.telegramCount}  ·  XMPP: ${report.config.xmppCount}  ` +
      `(XMPP usa additionalProperties:true — la brecha es de UI de setup/doctor, no funcional)`,
  );
  if (report.config.missingInXmpp.length > 0) {
    console.log(`Propiedades de Telegram no reflejadas en el manifiesto XMPP (primeras 15):`);
    for (const name of report.config.missingInXmpp.slice(0, 15)) console.log(`  - ${name}`);
    if (report.config.missingInXmpp.length > 15) {
      console.log(`  ... y ${report.config.missingInXmpp.length - 15} más`);
    }
  }

  const hasIssues = report.unclassified.length > 0 || report.staleDenyEntries.length > 0;
  process.exitCode = hasIssues ? 1 : 0;
}

main();
