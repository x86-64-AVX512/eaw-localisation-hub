import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { WebSocket } from 'ws';
import { MAX_MESSAGE_BYTES } from '../../../packages/shared/src/constants.mts';

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
  resolutions = new Map(), initialUnknown = false) {
  if (!binding.synced || binding.socket?.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('Server is unavailable'));
  }
  const requestId = crypto.randomUUID();
  const sharedHash = crypto.createHash('sha256').update(binding.text.toString()).digest('hex');
  const payload = JSON.stringify({ type: 'disk-merge-check', requestId, sharedHash,
    baseText, externalText, personalText, resolutions: Object.fromEntries(resolutions), initialUnknown });
  if (Buffer.byteLength(payload, 'utf8') > MAX_MESSAGE_BYTES) {
    return Promise.reject(new Error('Disk merge request exceeds protocol limit'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      binding.diskMergeRequests.delete(requestId);
      reject(new Error('Server disk merge check timed out'));
    }, 10_000);
    timer.unref?.();
    binding.diskMergeRequests.set(requestId, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    binding.socket.send(payload, (error) => {
      if (!error) return;
      const pending = binding.diskMergeRequests.get(requestId);
      if (pending) { binding.diskMergeRequests.delete(requestId); pending.reject(error); }
    });
  });
}
