import mongoose from 'mongoose';
import { isEncrypted } from '../utils/fieldEncryption.js';

/**
 * A sensitive value at rest: AES-256-GCM ciphertext plus its last four
 * characters for masked display (so lists never need to decrypt).
 *
 * The validator refuses anything that is not ciphertext, so a coding mistake
 * that passes plaintext fails loudly instead of storing it.
 */
export const encryptedValueSchema = new mongoose.Schema(
  {
    ciphertext: {
      type: String,
      required: true,
      validate: { validator: isEncrypted, message: 'Sensitive values must be stored encrypted.' },
    },
    last4: { type: String, required: true, maxlength: 4 },
  },
  { _id: false }
);

/** toJSON/toObject transform: ciphertext and blind indexes never leave the model by accident. */
export function stripSecrets(doc, ret) {
  const strip = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
      if (key === 'ciphertext' || key.endsWith('BlindIndex')) delete value[key];
      else strip(value[key]);
    }
  };
  strip(ret);
  delete ret.__v;
  return ret;
}
