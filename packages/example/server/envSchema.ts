import * as S from "effect/Schema";

// Schema for validating .env has all required fields
export const envSchema = S.Struct({
  NODE_ENV: S.String,
  ROOT_DATABASE_USER: S.String,
  ROOT_DATABASE_PASSWORD: S.String,
  DATABASE_HOST: S.String,
  DATABASE_PORT: S.String,
  DATABASE_NAME: S.String,
  DATABASE_OWNER: S.String,
  DATABASE_OWNER_PASSWORD: S.String,
  DATABASE_AUTHENTICATOR: S.String,
  DATABASE_AUTHENTICATOR_PASSWORD: S.String,
  DATABASE_VISITOR: S.String,
  SHADOW_DATABASE_PASSWORD: S.String,
  ROOT_DATABASE_URL: S.String,
  DATABASE_URL: S.String,
  AUTH_DATABASE_URL: S.String,
  SHADOW_DATABASE_URL: S.String,
  PORT: S.String,
  VITE_ROOT_URL: S.String,
  SECRET: S.String,
});

export type Env = S.Schema.Type<typeof envSchema>;
