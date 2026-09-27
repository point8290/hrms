import { post } from './api.ts';

/**
 * Uploading a document.
 *
 * The product never hands object-storage credentials to a browser. Instead the API issues a
 * presigned URL scoped to one key, one method and a few minutes; the browser puts the bytes
 * straight at storage; and a confirm call flips the record from `pending` to `available`.
 * That third step is what makes the document real — a row that was never confirmed points at
 * an object that may not exist, which is why nothing should reference a document id until
 * this function has returned.
 *
 * Content types are constrained on the server as well as here. This list exists so the file
 * picker offers the right things, not as the enforcement point.
 */
export const ACCEPTED_UPLOAD_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

/** 25 MB, matching the server's own bound. */
const MAX_BYTES = 25 * 1024 * 1024;

export type UploadedDocument = { documentId: string };

export async function uploadDocument(input: {
  file: File;
  documentType: string;
  employeeId?: string;
}): Promise<UploadedDocument> {
  const { file, documentType, employeeId } = input;

  if (file.size === 0) throw new Error('That file is empty.');
  if (file.size > MAX_BYTES) {
    throw new Error(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 25 MB.`);
  }
  // Browsers leave `type` empty for some files; the server is the authority, but a clear
  // message here beats an opaque rejection later.
  if (file.type && !(ACCEPTED_UPLOAD_TYPES as readonly string[]).includes(file.type)) {
    throw new Error(`${file.type} is not an accepted file type.`);
  }

  const issued = await post<{
    document_id: string;
    upload: { url: string; method: string; headers: Record<string, string>; expires_in: number };
  }>('/api/documents/upload-url', {
    documentType,
    filename: file.name,
    contentType: file.type || 'application/pdf',
    sizeBytes: file.size,
    ...(employeeId ? { employeeId } : {}),
  });

  // Straight at storage, without the API in the path — and deliberately without the session
  // token, which must never be sent to a storage host.
  const stored = await fetch(issued.upload.url, {
    method: issued.upload.method,
    headers: issued.upload.headers,
    body: file,
  });
  if (!stored.ok) {
    throw new Error(`The upload did not complete (${stored.status}). The claim was not changed.`);
  }

  await post(`/api/documents/${issued.document_id}/confirm`, {});
  return { documentId: issued.document_id };
}
