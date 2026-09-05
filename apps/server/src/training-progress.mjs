import { AuthError } from './auth-model.mjs';
import { publicUser } from './auth-model.mjs';

export async function updateTrainingProgress(store, actor, segmentId, revision) {
  const id = String(segmentId ?? '');
  const value = Number(revision);
  if (!/^[a-z0-9-]{1,64}$/u.test(id) || !Number.isInteger(value) || value < 1 || value > 10000) {
    throw new AuthError('Invalid training segment or revision', 400, 'invalid_training_progress');
  }
  const user = store.state.users.find(({ id: userId }) => userId === actor.id);
  if (!user) throw new AuthError('Account no longer exists', 404, 'user_not_found');
  user.trainingProgress ??= {};
  user.trainingProgress[id] = Math.max(Number(user.trainingProgress[id] ?? 0), value);
  await store.persist();
  return publicUser(user);
}
