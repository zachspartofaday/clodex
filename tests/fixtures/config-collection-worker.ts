import { setModelProfile, upsertModelAlias } from '../../src/config.js';

const workerId = process.env['CONFIG_WRITE_WORKER_ID'];
const writes = Number(process.env['CONFIG_WRITE_COUNT']);
const operation = process.env['CONFIG_COLLECTION_WORKER_OPERATION'];
if (!workerId || !Number.isInteger(writes) || writes <= 0) {
  throw new Error('Config collection worker requires an id and positive write count.');
}
if (operation !== 'profiles' && operation !== 'aliases') {
  throw new Error('Config collection worker requires a profiles or aliases operation.');
}

process.stdin.resume();
process.stdin.once('data', () => {
  for (let index = 0; index < writes; index += 1) {
    if (operation === 'profiles') {
      const name = `profile-${workerId}-${index}`;
      setModelProfile(name, {
        savedAt: new Date(0).toISOString(),
        favoriteModels: [],
        modelAliases: [],
      });
    } else {
      upsertModelAlias({
        name: `alias-${workerId}-${index}`,
        providerId: workerId,
        modelId: `model-${index}`,
      });
    }
  }
});
process.stdout.write('READY\n');
