import {
  AuthStorage,
  type ApiKeyCredential,
  type AuthCredential,
  type AuthStorageBackend,
  type OAuthCredential,
} from "@mariozechner/pi-coding-agent";

export type {
  ApiKeyCredential,
  AuthCredential,
  AuthStorageBackend,
  OAuthCredential,
};

export type PiAuthStorageInstance = AuthStorage;

export const createBundledPiAuthStorage = (
  authPath?: string,
): PiAuthStorageInstance => {
  return AuthStorage.create(authPath);
};
