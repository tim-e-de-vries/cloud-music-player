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
const googleapis_1 = require("googleapis");
const functions = __importStar(require("@google-cloud/functions-framework"));
const cors_1 = __importDefault(require("cors"));
// Initialize Firebase Admin SDK and Google Drive API (as above)
admin.initializeApp();
const db = admin.firestore();
const drive = googleapis_1.google.drive({
    version: 'v3',
    auth: new googleapis_1.google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/drive.readonly']
    })
});
// const auth = new google.auth.GoogleAuth({
//   scopes: ['https://www.googleapis.com/auth/drive.readonly'],
// });
// const drive = google.drive({ version: 'v3', auth });
// const drive = google.drive({ version: 'v3', auth });
const DRIVE_FOLDER_ID = '1VxClhCDuH0fX4Fkze3yJmkWQkYiutxOs'; //MP3s root
// Define the collection name for your songs
// Consider a structure like `users/{userId}/songs` if data is per-user
const SONGS_COLLECTION = 'songs';
const DELETIONS_COLLECTION = 'deletedSongs'; // To track files deleted from Drive
/**
 * Recursively fetches files and folders from Google Drive, including modifiedTime.
 * @param folderId The ID of the Google Drive folder to start scanning from.
 * @returns An array of Google Drive file/folder objects.
 */
// --- Initialize CORS Middleware ---
// This allows your frontend application to make requests to this function.
// For production, you should restrict the origin to your actual domain.
const corsMiddleware = (0, cors_1.default)({ origin: true });
async function fetchDriveFilesRecursively(folderId) {
    let allFiles = [];
    let pageToken = null;
    //   const query:string | undefined =  `'${folderId}' in parents and (mimeType contains 'audio/' or mimeType='application/vnd.google-apps.folder')`;
    try {
        do {
            const response = drive.files.list({
                q: `'${folderId}' in parents and (mimeType='audio/mpeg' or mimeType='audio/flac' or mimeType='audio/x-flac' or mimeType='audio/wav' or mimeType='application/vnd.google-apps.folder')`, // Explicitly define the type for 'response'
                fields: 'nextPageToken, files(id, name, mimeType, size, parents)',
                pageToken: pageToken || undefined,
                orderBy: 'name',
                pageSize: 1000 // Max page size for efficiency
            });
            //   const response: any = await drive.files.list({
            //       q: query,
            //       fields: 'nextPageToken, files(id, name, mimeType, size, parents, modifiedTime)', // Include modifiedTime
            //       pageToken: pageToken || under,
            //       orderBy: 'name',
            //       responseType: 'arraybuffer',
            //       pageSize: 1000 // Max page size for efficiency
            //   });
            const files = response.data.files || [];
            const formattedFiles = files.map(file => ({
                id: file.id,
                name: file.name,
                mimeType: file.mimeType,
                size: file.size, // Will be undefined for folders
                parents: file.parents || [],
                modifiedTime: file.modifiedTime, // Ensure this is always present
                isFolder: file.mimeType === 'application/vnd.google-apps.folder',
                _lastUpdated: admin.firestore.FieldValue.serverTimestamp() // Will be set later during Firestore write
            }));
            allFiles = allFiles.concat(formattedFiles);
            pageToken = response.data.nextPageToken;
            // Recursively search sub-folders
            for (const file of formattedFiles) { // Iterate over formatted files
                if (file.isFolder) {
                    const subFolderFiles = await fetchDriveFilesRecursively(file.id);
                    allFiles = allFiles.concat(subFolderFiles);
                }
            }
        } while (pageToken);
    }
    catch (error) {
        console.error(`Error fetching files from folder ${folderId}:`, error);
        throw error;
    }
    return allFiles;
}
/**
 * Syncs Google Drive files/folders metadata to Firestore using an upsert strategy.
 * This function handles both initial ingestion and subsequent updates/deletions.
 *
 * @param rootFolderId The Google Drive folder ID to start scanning.
 * @param userId (Optional) The user ID if you're scoping data per user.
 */
async function syncGoogleDriveToFirestore(rootFolderId, userId) {
    console.log(`Starting sync for user: ${userId || 'global'} from root folder: ${rootFolderId}`);
    let existingFirestoreFileIds = new Set();
    let firestoreBatch = db.batch();
    let writeCount = 0;
    const BATCH_SIZE = 400; // Max 500 operations per batch, leave some room for safety
    try {
        // 1. Fetch all existing file IDs from Firestore for comparison
        const existingDocsSnapshot = await db.collection(SONGS_COLLECTION)
            .where('userId', '==', userId || null) // Query by userId if provided
            .select('id', 'modifiedTime') // Only fetch what's needed for comparison
            .get();
        const existingFirestoreMetadata = new Map();
        existingDocsSnapshot.forEach(doc => {
            const data = doc.data();
            existingFirestoreFileIds.add(data.id);
            existingFirestoreMetadata.set(data.id, {
                modifiedTime: data.modifiedTime,
                lastUpdated: data._lastUpdated // Use _lastUpdated to track when *we* processed it
            });
        });
        console.log(`Found ${existingFirestoreFileIds.size} existing documents in Firestore.`);
        // 2. Fetch current files/folders from Google Drive
        const currentDriveFiles = await fetchDriveFilesRecursively(rootFolderId);
        const currentDriveFileIds = new Set();
        console.log(`Found ${currentDriveFiles.length} files/folders in Google Drive.`);
        // 3. Process each file/folder for upsert
        for (const file of currentDriveFiles) {
            currentDriveFileIds.add(file.id);
            const existingMetadata = existingFirestoreMetadata.get(file.id);
            const isModifiedInDrive = !existingMetadata || (file.modifiedTime > existingMetadata.modifiedTime); // Compare Drive's modifiedTime
            // You could also add a condition for _lastUpdated here if you want to force updates
            // for records we haven't processed recently, even if modifiedTime didn't change.
            if (!existingMetadata || isModifiedInDrive) {
                // Document either doesn't exist, or has been modified in Drive
                const docRef = db.collection(SONGS_COLLECTION).doc(file.id);
                const dataToSet = Object.assign(Object.assign({}, file), { userId: userId, _lastUpdated: admin.firestore.FieldValue.serverTimestamp() // Our timestamp
                 });
                firestoreBatch.set(docRef, dataToSet, { merge: true }); // Upsert
                writeCount++;
                if (writeCount === BATCH_SIZE) {
                    console.log(`Committing batch of ${writeCount} writes...`);
                    await firestoreBatch.commit();
                    writeCount = 0;
                    firestoreBatch = db.batch(); // Start a new batch
                }
            }
        }
        // Commit any remaining writes
        if (writeCount > 0) {
            console.log(`Committing final batch of ${writeCount} writes...`);
            await firestoreBatch.commit();
        }
        console.log('Finished processing Google Drive updates/new files.');
        // 4. Identify and delete files no longer present in Google Drive
        let deletionBatch = db.batch();
        let deleteCount = 0;
        for (const firestoreFileId of existingFirestoreFileIds) {
            if (!currentDriveFileIds.has(firestoreFileId)) {
                // This file exists in Firestore but is no longer in Google Drive
                const docRef = db.collection(SONGS_COLLECTION).doc(firestoreFileId);
                deletionBatch.delete(docRef);
                deleteCount++;
                // Optionally, record deleted songs for client-side synchronization or auditing
                let deletedDocRef = db.collection(DELETIONS_COLLECTION).doc(firestoreFileId);
                deletionBatch.set(deletedDocRef, {
                    id: firestoreFileId,
                    userId: userId,
                    deletedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                deleteCount++; // This counts as another operation in the batch
                if (deleteCount >= BATCH_SIZE) { // Ensure batch size respects operations for delete + set
                    console.log(`Committing batch of ${deleteCount} deletions...`);
                    await deletionBatch.commit();
                    deleteCount = 0;
                    deletionBatch = db.batch(); // Start a new batch
                }
            }
        }
        // Commit any remaining deletions
        if (deleteCount > 0) {
            console.log(`Committing final batch of ${deleteCount} deletions...`);
            await deletionBatch.commit();
        }
        console.log('Finished processing Google Drive deletions.');
    }
    catch (error) {
        console.error(`Error syncing Google Drive to Firestore for user ${userId || 'global'}:`, error);
        throw error;
    }
    console.log(`Sync complete for user: ${userId || 'global'}.`);
}
functions.http('fetchDriveFilesRecursively', async (req, res) => {
    // Use the CORS middleware
    // let pageToken = null;
    corsMiddleware(req, res, async () => {
        try {
            console.log(`Fetching files from folder: ${DRIVE_FOLDER_ID}`);
            const fileList = await fetchDriveFilesRecursively(DRIVE_FOLDER_ID);
            if (!fileList || fileList.length === 0) {
                res.status(404).send('No audio files found in the specified folder.');
                return;
            }
            console.log(`Found ${fileList.length} files.`);
            res.status(200).json(fileList);
        }
        catch (error) {
            console.error('Error fetching file list from Google Drive:', error);
            res.status(500).send('Failed to retrieve file list from Google Drive.');
        }
    });
});
functions.http('syncGoogleDriveToFirestore', async (req, res) => {
    // Use the CORS middleware
    // let pageToken = null;
    corsMiddleware(req, res, async () => {
        try {
            console.log(`Fetching files from folder: ${DRIVE_FOLDER_ID}`);
            const fileList = await syncGoogleDriveToFirestore(DRIVE_FOLDER_ID);
            if (!fileList || fileList.length === 0) {
                res.status(404).send('No audio files found in the specified folder.');
                return;
            }
            console.log(`Found ${fileList.length} files.`);
            res.status(200).json(fileList);
        }
        catch (error) {
            console.error('Error fetching file list from Google Drive:', error);
            res.status(500).send('Failed to retrieve file list from Google Drive.');
        }
    });
});
// // Example usage within a Google Cloud Function (e.g., triggered by Pub/Sub or HTTP)
// // This GCF would need appropriate IAM permissions to access Google Drive API and Firestore.
// export const syncMusicLibrary = functions.pubsub.topic('google-drive-changes').onPublish(async (message, context) => {
//   // You'd need logic here to determine the rootFolderId and userId
//   // This could come from a message payload if you're using Drive's Change Tracking API
//   // or a fixed value for a single-user setup.
//   const userId = 'your_user_id'; // Or extract from message/auth
//   const rootFolderId = 'YOUR_GOOGLE_DRIVE_ROOT_MUSIC_FOLDER_ID';
//   try {
//     await syncGoogleDriveToFirestore(rootFolderId, userId);
//     console.log('Music library sync successful!');
//   } catch (error) {
//     console.error('Failed to sync music library:', error);
//     // Depending on your error handling, you might want to re-queue the message
//     // or log it for manual intervention.
//     throw new functions.https.HttpsError('internal', 'Failed to sync music library', error);
//   }
// });
//# sourceMappingURL=firestore_upsert.js.map