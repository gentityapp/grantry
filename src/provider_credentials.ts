import type { Connection, ProviderCredential, Tenant } from "@prisma/client";
import { deriveCredentialHealth } from "./connectors/credential_meta.js";
import { prisma } from "./db.js";

type ConnectionSecretFields = Pick<
  Connection,
  | "id"
  | "provider"
  | "authType"
  | "label"
  | "ownerId"
  | "workspaceId"
  | "encryptedCredential"
  | "encryptedServerCredential"
  | "credentialMetadata"
  | "credentialValidatedAt"
  | "refreshToken"
  | "accessTokenExpiresAt"
  | "credentialId"
>;

type CredentialMetadataWrite = {
  encryptedCredential?: string;
  encryptedServerCredential?: string | null;
  credentialMetadata?: string;
  credentialValidatedAt?: Date | null;
  healthStatus?: string | null;
  healthCheckedAt?: Date | null;
  healthLastOkAt?: Date | null;
  healthErrorCode?: string | null;
  healthErrorMessage?: string | null;
  healthMissingScopes?: string;
  refreshToken?: string | null;
  accessTokenExpiresAt?: Date | null;
};

export function connectionCredentialData<T extends CredentialMetadataWrite>(data: T) {
  const { healthStatus, healthCheckedAt, healthLastOkAt, healthErrorCode, healthErrorMessage, healthMissingScopes, ...rest } = data;
  return {
    ...rest,
    ...(healthStatus !== undefined ? { healthStatusSnapshot: healthStatus } : {}),
    ...(healthCheckedAt !== undefined ? { healthCheckedAtSnapshot: healthCheckedAt } : {}),
  };
}

export function providerCredentialData<T extends CredentialMetadataWrite>(data: T) {
  const { ...rest } = data;
  return rest;
}

function healthFromConnection(conn: ConnectionSecretFields) {
  return deriveCredentialHealth({
    credentialMetadata: conn.credentialMetadata,
    credentialValidatedAt: conn.credentialValidatedAt,
    accessTokenExpiresAt: conn.accessTokenExpiresAt,
  });
}

function requireWorkspaceId(workspaceId: string | null, connectionId?: string): string {
  if (!workspaceId) {
    throw new Error(`workspace_id is required to share provider credentials${connectionId ? ` (connection=${connectionId})` : ""}`);
  }
  return workspaceId;
}

export async function ensureProviderCredentialForConnection(
  conn: ConnectionSecretFields,
  createdById?: string,
): Promise<ProviderCredential> {
  if (conn.credentialId) {
    const existing = await prisma.providerCredential.findUnique({ where: { id: conn.credentialId } });
    if (existing) return existing;
  }

  const credential = await prisma.providerCredential.create({
    data: {
      workspaceId: requireWorkspaceId(conn.workspaceId, conn.id),
      ownerId: conn.ownerId,
      provider: conn.provider,
      authType: conn.authType,
      label: conn.label,
      encryptedCredential: conn.encryptedCredential,
      encryptedServerCredential: conn.encryptedServerCredential,
      credentialMetadata: conn.credentialMetadata,
      credentialValidatedAt: conn.credentialValidatedAt,
      ...healthFromConnection(conn),
      refreshToken: conn.refreshToken,
      accessTokenExpiresAt: conn.accessTokenExpiresAt,
      createdById,
    },
  });

  await prisma.connection.update({
    where: { id: conn.id },
    data: { credentialId: credential.id },
  });
  return credential;
}

export async function createTenantConnectionFromCredential(args: {
  tenant: Pick<Tenant, "id" | "slug" | "workspaceId" | "ownerId">;
  sourceConnection: ConnectionSecretFields;
  createdById: string;
}): Promise<Connection> {
  const workspaceId = requireWorkspaceId(args.tenant.workspaceId, args.sourceConnection.id);
  if (args.sourceConnection.workspaceId !== workspaceId) {
    throw new Error("cannot reuse a provider credential across workspaces");
  }
  if (args.sourceConnection.ownerId !== args.tenant.ownerId) {
    throw new Error("cannot reuse a provider credential across owners");
  }

  const credential = await ensureProviderCredentialForConnection(args.sourceConnection, args.createdById);
  const existing = await prisma.connection.findFirst({
    where: {
      ownerId: args.tenant.ownerId,
      workspaceId,
      tenantId: args.tenant.id,
      provider: args.sourceConnection.provider,
      authType: args.sourceConnection.authType,
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return existing;

  return prisma.connection.create({
    data: {
      provider: args.sourceConnection.provider,
      authType: args.sourceConnection.authType,
      label: `${args.sourceConnection.provider}-${args.tenant.slug}-${args.sourceConnection.authType}`,
      scope: args.tenant.slug,
      tenantId: args.tenant.id,
      ownerId: args.tenant.ownerId,
      workspaceId,
      credentialId: credential.id,
      encryptedCredential: credential.encryptedCredential,
      encryptedServerCredential: credential.encryptedServerCredential,
      credentialMetadata: credential.credentialMetadata,
      credentialValidatedAt: credential.credentialValidatedAt,
      healthStatusSnapshot: credential.healthStatus,
      healthCheckedAtSnapshot: credential.healthCheckedAt,
      refreshToken: credential.refreshToken,
      accessTokenExpiresAt: credential.accessTokenExpiresAt,
      enabled: credential.enabled,
    },
  });
}

export async function syncProviderCredentialFromConnection(conn: ConnectionSecretFields) {
  if (!conn.credentialId) return;
  const data = {
    encryptedCredential: conn.encryptedCredential,
    encryptedServerCredential: conn.encryptedServerCredential,
    credentialMetadata: conn.credentialMetadata,
    credentialValidatedAt: conn.credentialValidatedAt,
    ...healthFromConnection(conn),
    refreshToken: conn.refreshToken,
    accessTokenExpiresAt: conn.accessTokenExpiresAt,
  };
  await prisma.$transaction([
    prisma.providerCredential.update({
      where: { id: conn.credentialId },
      data: { label: conn.label, ...data, enabled: true },
    }),
    prisma.connection.updateMany({
      where: { credentialId: conn.credentialId },
      data: connectionCredentialData(data),
    }),
  ]);
}

export async function rotateSharedCredential(args: {
  credentialId: string | null;
  connectionId: string;
  data: CredentialMetadataWrite;
}) {
  if (!args.credentialId) {
    await prisma.connection.update({ where: { id: args.connectionId }, data: connectionCredentialData(args.data) });
    return;
  }
  await prisma.$transaction([
    prisma.providerCredential.update({ where: { id: args.credentialId }, data: providerCredentialData(args.data) }),
    prisma.connection.updateMany({ where: { credentialId: args.credentialId }, data: connectionCredentialData(args.data) }),
  ]);
}
