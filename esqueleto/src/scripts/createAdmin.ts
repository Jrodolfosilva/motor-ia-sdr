// Cria (ou reconfigura) um admin e mostra o QR code para o app autenticador.
//   npm run admin:create -- --name rodolfo --email rodolfo@x.com [--qr caminho.png] [--reset]
// --reset gera um segredo novo (celular perdido/trocado): o QR antigo para de funcionar.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import mongoose from 'mongoose';
import QRCode from 'qrcode';

const ENV_FILE = join(__dirname, '../../.env');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

import { connectMongo } from '../db/connection';
import { UserModel } from '../db/models/User';
import { newTotpSecret, otpauthUri } from '../auth/totp';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const name = arg('name');
  const email = arg('email')?.trim().toLowerCase();
  const qrPath = arg('qr');
  const reset = process.argv.includes('--reset');
  if (!name || !email) throw new Error('Uso: --name <nome> --email <email> [--qr arquivo.png] [--reset]');

  await connectMongo();
  const existing = await UserModel.findOne({ email });
  if (existing && !reset) {
    console.log(`Usuário ${email} já existe. Use --reset para gerar um novo QR (invalida o anterior).`);
    return;
  }

  const secret = newTotpSecret();
  if (existing) {
    await UserModel.updateOne({ _id: existing._id }, { $set: { name, totpSecret: secret, totpLastStep: 0, active: true } });
  } else {
    await UserModel.create({ name, email, role: 'admin', totpSecret: secret });
  }

  const uri = otpauthUri(secret, email);
  console.log(`\nAdmin ${existing ? 'reconfigurado' : 'criado'}: ${name} <${email}>`);
  console.log('Escaneie no app autenticador (Google Authenticator, Microsoft Authenticator, Authy…):\n');
  console.log(await QRCode.toString(uri, { type: 'terminal', small: true }));
  console.log(`Sem câmera? Digite a chave no app: ${secret.replace(/(.{4})/g, '$1 ').trim()}`);
  if (qrPath) {
    await QRCode.toFile(qrPath, uri, { width: 360, margin: 2 });
    console.log(`QR salvo em ${qrPath} (apague depois de escanear).`);
  }
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
