/**
 * The largest file a person can upload. The API enforces it, the web app checks it before sending, and
 * client_max_body_size in infra/nginx.conf is this plus room for the multipart wrapper.
 */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
