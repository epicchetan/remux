import { File, UploadType, type UploadProgress } from 'expo-file-system';

import { logRemuxDebug } from '../remote/remuxDebug';
import { joinPath } from './fileMutations';
import {
  rawFileUploadUrl,
  uploadResultForStatus,
  type FileUploadResult,
} from './fileUploadResult';

export type FileUploadRequest = {
  directory: string;
  name: string;
  onProgress?: (progress: UploadProgress) => void;
  origin: string;
  overwrite?: boolean;
  sourceUri: string;
  token: string;
};

/**
 * Streams the picked asset straight from its cache URI into the raw route:
 * nothing is read into JavaScript memory. `uploadAsync` resolves for every
 * completed HTTP response, including 409 and 413, so those become results
 * rather than throws.
 */
export async function uploadFileToDirectory({
  directory,
  name,
  onProgress,
  origin,
  overwrite = false,
  sourceUri,
  token,
}: FileUploadRequest): Promise<FileUploadResult> {
  let phase = 'preparing';
  try {
    logRemuxDebug('app:files:upload:start', { directory, name, overwrite });
    const task = new File(sourceUri).createUploadTask(
      rawFileUploadUrl(origin, joinPath(directory, name), { overwrite }),
      {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        httpMethod: 'PUT',
        ...(onProgress ? { onProgress } : {}),
        uploadType: UploadType.BINARY_CONTENT,
      },
    );
    phase = 'uploading';
    const response = await task.uploadAsync();
    const result = uploadResultForStatus(response.status, response.body);
    logRemuxDebug('app:files:upload:response', {
      directory, name, overwrite, httpStatus: response.status,
      result: result.status, ...(result.status === 'failed' ? { reason: result.reason } : {}),
    });
    return result;
  } catch (error) {
    const reason = uploadFailureReason(error);
    logRemuxDebug('app:files:upload:failed', { directory, name, overwrite, phase, reason });
    return { reason, status: 'failed' };
  }
}

// Transport failures reject with an error whose message carries the detail;
// there is no structured status to read.
function uploadFailureReason(error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).trim();
  return message.length > 0 ? message : 'The file could not be uploaded.';
}
