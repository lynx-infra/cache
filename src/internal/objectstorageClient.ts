// https://github.com/actions/toolkit/blob/main/packages/cache/src/cache.ts
// 6c4e082c181a51609197e536ef5255a0c9baeef7

import { readFileSync } from "fs"
import { join } from "path";
import * as core from "@actions/core";
import { TosClient, TosClientError, TosServerError } from "@volcengine/tos-sdk";
import * as crypto from "crypto";

import { DownloadOptions, UploadOptions } from "../options";
import * as utils from "./cacheUtils";
import { CompressionMethod } from "./constants";
import { ArtifactCacheEntry, InternalCacheOptions } from "./contracts.d";

const versionSalt = "1.0";

const repo = process.env["GITHUB_REPOSITORY"];
// TODO(coolkiid): make it compatible with Windows machine.
const credentialsPath = process.env["TOS_CREDENTIALS_PATH"] || "/etc/tos-credentials"

/**
 * Get TOS credentials from environment variable or file
 * @param {string} key - the key of credentials
 * @returns {string | undefined}
 *  - returns value from environment variable if set.
 *  - returns value from file if it is not empty.
 *  - returns undefined when environment variable is not set AND 
 *      (credentials file does not exist (ENOENT) OR credentials file is empty).
 * @throws {Error} when reading credentials file fails with non-ENOENT error.
 */
function getCredentials(key: string): string | undefined {
    if (process.env[`TOS_${key}`]) {
        core.debug(`use TOS_${key} from environment variable.`);
        return process.env[`TOS_${key}`] as string;
    }

    const credentialsFile = join(credentialsPath, `TOS_${key}`);
    try {
        const value = readFileSync(credentialsFile, "utf8").trim();
        if (!value) {
            core.warning(`a null value was read from the file: ${credentialsFile}`);
            return undefined;
        }
        core.debug(`use TOS_${key} from file: ${credentialsFile}`);
        return value;
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            core.debug(`credentials file ${credentialsFile} not found`);
            return undefined;
        } else {
            core.error(`an error occurred when reading credentials file ${credentialsFile}`, error);
            throw new Error(`Error loading credentials from file ${credentialsFile}: ${error.message}`);
        }
    }
}

function createObjectStorageClient(): TosClient {
    const endpoint = getCredentials("ENDPOINT");
    const opts = endpoint
        ? { endpoint: endpoint, secure: false }
        : { secure: true };

    return new TosClient({
        accessKeyId: getCredentials("ACCESS_KEY") as string,
        accessKeySecret: getCredentials("SECRET_KEY") as string,
        region: getCredentials("REGION") as string,
        ...opts
    });
}

export function getCacheVersion(
    paths: string[],
    compressionMethod?: CompressionMethod,
    enableCrossOsArchive = false
): string {
    // don't pass changes upstream
    const components = paths.slice();

    // Add compression method to cache version to restore
    // compressed cache as per compression method
    if (compressionMethod) {
        components.push(compressionMethod);
    }

    // Only check for windows platforms if enableCrossOsArchive is false
    if (process.platform === "win32" && !enableCrossOsArchive) {
        components.push("windows-only");
    }

    // Add salt to cache version to support breaking changes in cache entry
    components.push(versionSalt);

    return crypto
        .createHash("sha256")
        .update(components.join("|"))
        .digest("hex");
}

async function getPrimaryKeyCacheEntry(
    client: TosClient,
    version: string,
    primaryKey: string
): Promise<ArtifactCacheEntry | null> {
    const objectKey = `caches/${repo}/${primaryKey}`;
    try {
        await client.headObject({
            bucket: getCredentials("BUCKET_NAME") as string,
            key: objectKey
        });
        const entry: ArtifactCacheEntry = {
            cacheKey: primaryKey,
            cacheVersion: version,
            objectKey: objectKey
        };
        return entry;
    } catch (error) {
        if (error instanceof TosServerError && error.statusCode === 404) {
            console.warn(
                `Unable to find cache with primary key: ${objectKey}.`
            );
        }
        return null;
    }
}

async function getRestoreKeysCacheEntry(
    client: TosClient,
    version: string,
    restoreKeys: string[]
): Promise<ArtifactCacheEntry | null> {
    for (const key of restoreKeys) {
        const prefix = `caches/${repo}/${key}`;
        try {
            const { data } = await client.listObjectsType2({
                bucket: getCredentials("BUCKET_NAME") as string,
                prefix: prefix,
                maxKeys: 100
            });

            if (data.Contents.length == 0) {
                console.warn(
                    `Unable to find cache with restore key ${prefix}.`
                );
                continue;
            }

            let index = 0;
            let latestModifiedTime = new Date(data.Contents[index].LastModified).getTime();
            for (let i = 1; i < data.Contents.length; i++) {
                const modifiedTime = new Date(data.Contents[i].LastModified).getTime();
                if (modifiedTime > latestModifiedTime) {
                    index = i;
                    latestModifiedTime = modifiedTime;
                }
            }

            const matchedKey: string = data.Contents[index].Key;
            const entry: ArtifactCacheEntry = {
                cacheKey: matchedKey,
                cacheVersion: version,
                objectKey: matchedKey
            };
            return entry;
        } catch (error) {
            console.warn(
                `an error occurred when trying to find cache with restore key ${prefix}`
            );
            handleError(error);
        }
    }
    return null;
}

export async function getCacheEntry(
    keys: string[],
    paths: string[],
    options?: InternalCacheOptions
): Promise<ArtifactCacheEntry | null> {
    const client = createObjectStorageClient();
    const version = getCacheVersion(
        paths,
        options?.compressionMethod,
        options?.enableCrossOsArchive
    );

    let entry = await getPrimaryKeyCacheEntry(client, version, keys[0]);
    if (entry) {
        return entry;
    }

    entry = await getRestoreKeysCacheEntry(client, version, keys.slice(1));
    if (entry) {
        return entry;
    }

    entry = {
        cacheVersion: version
    };
    console.warn(`Failed to find cache that matches keys: ${keys}`);
    return entry;
}

export async function downloadCache(
    objectKey: string,
    archivePath: string,
    options?: DownloadOptions
): Promise<void> {
    const client = createObjectStorageClient();
    await client.getObjectToFile({
        bucket: getCredentials("BUCKET_NAME") as string,
        key: objectKey,
        filePath: archivePath
    });
}

function handleError(error) {
    if (error instanceof TosClientError) {
        console.log("Client Err Msg:", error.message);
        console.log("Client Err Stack:", error.stack);
    } else if (error instanceof TosServerError) {
        console.log("Request ID:", error.requestId);
        console.log("Response Status Code:", error.statusCode);
        console.log("Response Header:", error.headers);
        console.log("Response Err Code:", error.code);
        console.log("Response Err Msg:", error.message);
    } else {
        console.log("unexpected exception, message: ", error);
    }
}

async function uploadFile(
    client: TosClient,
    cacheId: string,
    archivePath: string,
    options?: UploadOptions
): Promise<void> {
    try {
        const objectName = `caches/${repo}/${cacheId}`;
        await client.putObjectFromFile({
            bucket: getCredentials("BUCKET_NAME") as string,
            key: objectName,
            filePath: archivePath
        });
    } catch (error) {
        handleError(error);
    }
}

export async function saveCache(
    cacheId: string,
    archivePath: string,
    options?: UploadOptions
): Promise<void> {
    const client = createObjectStorageClient();

    core.debug("Upload cache");
    await uploadFile(client, cacheId, archivePath, options);

    // Commit Cache
    core.debug("Commiting cache");
    const cacheSize = utils.getArchiveFileSizeInBytes(archivePath);
    core.info(
        `Cache Size: ~${Math.round(
            cacheSize / (1024 * 1024)
        )} MB (${cacheSize} B)`
    );

    core.info("Cache saved successfully");
}
