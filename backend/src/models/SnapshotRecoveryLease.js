import mongoose from 'mongoose';

const snapshotRecoveryLeaseSchema = new mongoose.Schema(
  {
    resourceKey: { type: String, required: true, unique: true },
    ownerToken: { type: String, required: true },
    fence: { type: Number, required: true, min: 1 },
    leaseExpiresAt: { type: Date, required: true },
    acquiredAt: { type: Date, required: true },
  },
  { versionKey: false }
);

export default mongoose.model('SnapshotRecoveryLease', snapshotRecoveryLeaseSchema);
