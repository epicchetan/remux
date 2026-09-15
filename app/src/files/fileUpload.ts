import { File, UploadType, type UploadProgress } from 'expo-file-system';

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
  try {
    const task = new File(sourceUri).createUploadTask(
      rawFileUploadUrl(origin, joinPath(directory, name), { overwrite }),
      {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        httpMethod: 'PUT',
        ...(onProgress ? { onProgress } : {}),
        uploadType: UploadType.BINARY_CONTENT,
      },
    );
    const response = await task.uploadAsync();
    return uploadResultForStatus(response.status, response.body);
  } catch (error) {
    return { reason: uploadFailureReason(error), status: 'failed' };
  }
}

// Transport failures reject with an error whose message carries the detail;
// there is no structured status to read.
function uploadFailureReason(error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).split('\n')[0]?.trim() ?? '';
  return message.length > 0 ? message : 'The file could not be uploaded.';
}
