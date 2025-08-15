"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncGoogleDriveToFirestore = syncGoogleDriveToFirestore;
const admin = __importStar(require("firebase-admin"));
const functions = __importStar(require("@google-cloud/functions-framework"));
const cors_1 = __importDefault(require("cors"));
const drive_service_1 = require("./drive.service");
const metadata_service_1 = require("./metadata.service");
const firestore_service_1 = require("./firestore.service");
admin.initializeApp();
const DRIVE_FOLDER_ID = '1VxClhCDuH0fX4Fkze3yJmkWQkYiutxOs';
const corsMiddleware = (0, cors_1.default)({ origin: true });
async function processDriveFolder(folderId, existingFirestoreMetadata, userId) {
    let pageToken = null;
    const currentDriveFileIds = new Set();
    const foldersToProcess = [folderId];
    while (foldersToProcess.length > 0) {
        const currentFolderId = foldersToProcess.shift();
        do {
            const response = await drive_service_1.drive.files.list({
                q: `'${currentFolderId}' in parents and (mimeType='audio/mpeg' or mimeType='audio/flac' or mimeType='audio/x-flac' or mimeType='audio/wav' or mimeType='application/vnd.google-apps.folder')`,
                fields: 'nextPageToken, files(id, name, mimeType, size, parents, modifiedTime)',
                pageToken: pageToken || undefined,
                pageSize: 200, // Process in smaller batches
            });
            const files = response.data.files || [];
            const songsToWrite = [];
            for (const file of files) {
                currentDriveFileIds.add(file.id);
                if (file.mimeType === 'application/vnd.google-apps.folder') {
                    foldersToProcess.push(file.id);
                    continue;
                }
                const existingMetadata = existingFirestoreMetadata.get(file.id);
                if (!existingMetadata || (file.modifiedTime > existingMetadata.modifiedTime)) {
                    const songMetadata = {
                        id: file.id,
                        name: file.name,
                        mimeType: file.mimeType,
                        size: file.size,
                        parents: file.parents || [],
                        modifiedTime: file.modifiedTime,
                        isFolder: false,
                    };
                    songMetadata.inFolderName = await (0, drive_service_1.getParentFolderName)(file.id);
                    const id3Data = await (0, metadata_service_1.getMusicMetadata)(file.id);
                    songsToWrite.push(Object.assign(Object.assign({}, songMetadata), id3Data));
                }
            }
            if (songsToWrite.length > 0) {
                console.log(`Writing ${songsToWrite.length} songs to Firestore.`);
                await (0, firestore_service_1.batchWriteSongs)(songsToWrite, userId);
            }
            pageToken = response.data.nextPageToken;
        } while (pageToken);
    }
    return currentDriveFileIds;
}
async function syncGoogleDriveToFirestore(rootFolderId, userId) {
    console.log(`Starting sync for user: ${userId || 'global'} from root folder: ${rootFolderId}`);
    try {
        const existingFirestoreMetadata = await (0, firestore_service_1.getExistingFileMetadata)(userId);
        const existingFirestoreFileIds = new Set(existingFirestoreMetadata.keys());
        console.log(`Found ${existingFirestoreFileIds.size} existing documents in Firestore.`);
        const currentDriveFileIds = await processDriveFolder(rootFolderId, existingFirestoreMetadata, userId);
        console.log(`Found ${currentDriveFileIds.size} files/folders in Google Drive.`);
        const filesToDelete = [...existingFirestoreFileIds].filter(id => !currentDriveFileIds.has(id));
        if (filesToDelete.length > 0) {
            console.log(`Deleting ${filesToDelete.length} songs from Firestore.`);
            await (0, firestore_service_1.deleteSongs)(filesToDelete, userId);
        }
    }
    catch (error) {
        console.error(`Error syncing Google Drive to Firestore for user ${userId || 'global'}:`, error);
        throw error;
    }
    console.log(`Sync complete for user: ${userId || 'global'}.`);
}
functions.http('syncGoogleDrive', async (req, res) => {
    corsMiddleware(req, res, async () => {
        try {
            const { folderId } = req.query;
            const targetFolderId = typeof folderId === 'string' ? folderId : DRIVE_FOLDER_ID;
            await syncGoogleDriveToFirestore(targetFolderId);
            res.status(200).send('Sync completed successfully.');
        }
        catch (error) {
            console.error('Error during Google Drive sync:', error);
            res.status(500).send('Failed to sync with Google Drive.');
        }
    });
});
functions.http('streamMusicFile', async (req, res) => {
    corsMiddleware(req, res, async () => {
        const { fileId } = req.query;
        if (!fileId || typeof fileId !== 'string') {
            res.status(400).send('File ID is required.');
            return;
        }
        try {
            console.log(`Streaming file with ID: ${fileId}`);
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Accept-Ranges', 'bytes');
            const fileStream = await drive_service_1.drive.files.get({ fileId: fileId, alt: 'media' }, { responseType: 'stream' });
            fileStream.data.on('error', (err) => {
                console.error('Error during file stream:', err);
                res.status(500).send('Error streaming the file.');
            }).pipe(res);
        }
        catch (error) {
            console.error(`Error streaming file ${fileId}:`, error);
            res.status(500).send('Failed to stream the file.');
        }
    });
});
//# sourceMappingURL=index.js.map