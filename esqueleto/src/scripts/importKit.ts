// Reimporta o kit.json do disco para o MongoDB, sobrescrevendo o agente de mesma chave
// (o link público é mantido). Edições feitas no painel para esse agente se perdem.
//   npm run kit:import [-- caminho/kit.json]
// Depois reinicie o app: o servidor guarda o agente em cache.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import mongoose from 'mongoose';

const ENV_FILE = join(__dirname, '../../.env');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

import { connectMongo } from '../db/connection';
import { KitModel } from '../db/models/Kit';
import { readKitJson } from '../adapters/kitRepo';

async function main() {
  const path = process.argv[2] ?? process.env.KIT_PATH ?? join(__dirname, '../../../kits/salario-maternidade/kit.json');
  const raw = readKitJson(path);
  const key: string = raw.key;
  if (!key) throw new Error(`${path} não tem "key"`);

  await connectMongo();
  const r = await KitModel.updateOne(
    { _id: key },
    { $set: { data: { ...raw, key } }, $setOnInsert: { publicLink: { enabled: false, token: null } } },
    { upsert: true },
  );
  console.log(`Agente "${key}" ${r.upsertedCount ? 'criado' : 'atualizado'} a partir de ${path}. Reinicie o app para valer.`);
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
