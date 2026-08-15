// Main-orchestrator assign: pick an eligible machine, then enqueue a peer message.
// Does not use the job-plane dispatcher. send stays enqueue-only.
import { listMachineRecords, listMachines, pickMachine, sendMessage } from "./peers.mjs";
import { collectMachineProbes, peersHttp } from "./peers-serve.mjs";

export async function assignTask({
  from,
  text,
  pair,
  harness,
  computer,
  machines,
  probes
} = {}) {
  if (!from) throw new Error("assign: from is required");
  const body = text == null ? "" : String(text);
  if (!body) throw new Error("assign: a text payload is required");

  const rows =
    machines ??
    listMachines({
      probes: probes ?? (await collectMachineProbes(listMachineRecords(), { pair }))
    });
  const machine = pickMachine(rows);
  if (!machine) {
    const err = new Error("no eligible machine: need available and not busy");
    err.code = "PEER_NO_CAPACITY";
    err.machines = rows;
    throw err;
  }

  const to = machine.session.name;
  let message;
  if (machine.url) {
    const sender = await peersHttp(machine.url, {
      method: "POST",
      path: "/peers/register",
      token: pair,
      body: { name: from, harness: harness ?? null, computer: computer ?? null }
    });
    message = await peersHttp(machine.url, {
      method: "POST",
      path: "/peers/send",
      token: sender.token,
      body: { to, from: sender.name, text: body }
    });
  } else {
    message = sendMessage({ to, from, text: body });
  }

  return { machine, message, to, remote: Boolean(machine.url) };
}
