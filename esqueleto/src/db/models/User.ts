// Coleção `users`: quem entra no painel. Login = e-mail + código do app autenticador (TOTP).
import { Schema, model, type Types } from 'mongoose';

export interface UserDoc {
  _id: Types.ObjectId;
  name: string;
  email: string;
  role: 'admin';
  /** Segredo TOTP em base32. Nunca sai do servidor. */
  totpSecret: string;
  /** Último passo TOTP aceito: o mesmo código não entra duas vezes. */
  totpLastStep: number;
  active: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<UserDoc>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    role: { type: String, enum: ['admin'], default: 'admin' },
    totpSecret: { type: String, required: true, select: false },
    totpLastStep: { type: Number, default: 0, select: false },
    active: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

export const UserModel = model<UserDoc>('User', UserSchema, 'users');
