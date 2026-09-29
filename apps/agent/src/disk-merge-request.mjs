import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { WebSocket } from 'ws';
import { MAX_MESSAGE_BYTES } from '../../../packages/shared/src/constants.mts';
import { encodeMergeText, decodeMergeText } from '../../../packages/shared/src/merge-wire.mts';

export function rejectDiskMergeRequests(binding) {
  for (const request of binding.diskMergeRequests.values()) request.reject(new Error('Server disconnected'));
  binding.diskMergeRequests.clear();
}

export function receiveDiskMergeResult(binding, message) {
  const request = binding.diskMergeRequests.get(message.requestId);
  if (!request) return;
  binding.diskMergeRequests.delete(message.requestId);
  request.resolve(message);
}

export function requestDiskMergeCheck(binding, baseText, externalText, personalText,
  resolutions = new Map(), initialUnknown = false, resolutionRevision = '') {
  if (!binding.synced || binding.socket?.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('Server is unavailable'));
  }
  const requestId = crypto.randomUUID();
  const sharedSnapshot = binding.text.toString();
  const sharedHash = crypto.createHash('sha256').update(sharedSnapshot).digest('hex');
  const payload = JSON.stringify({ type: 'disk-merge-check', requestId, sharedHash,
    textPatches: { baseText: encodeMergeText(sharedSnapshot, baseText),
      externalText: encodeMergeText(sharedSnapshot, externalText),
      personalText: encodeMergeText(sharedSnapshot, personalText) },
    resolutions: Object.fromEntries(resolutions), initialUnknown, resolutionRevision });
  if (Buffer.byteLength(payload, 'utf8') > MAX_MESSAGE_BYTES) {
    return Promise.reject(Object.assign(new Error('Изменения файла превышают лимит проверки; уменьшите объём одновременных изменений.'),
      { code: 'EAW_MERGE_LIMIT' }));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      binding.diskMergeRequests.delete(requestId);
      reject(new Error('Server disk merge check timed out'));
    }, 10_000);
    timer.unref?.();
    binding.diskMergeRequests.set(requestId, {
      resolve: (value) => {
        clearTimeout(timer);
        try {
          if (value.textPatches) {
            value = { ...value, sharedText: decodeMergeText(sharedSnapshot, value.textPatches.sharedText),
              personalText: decodeMergeText(sharedSnapshot, value.textPatches.personalText) };
          }
          resolve(value);
        } catch (error) { reject(error); }
      },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    binding.socket.send(payload, (error) => {
      if (!error) return;
      const pending = binding.diskMergeRequests.get(requestId);
      if (pending) { binding.diskMergeRequests.delete(requestId); pending.reject(error); }
    });
  });
}
