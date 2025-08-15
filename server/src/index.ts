import * as admin from 'firebase-admin';
import * as functions from '@google-cloud/functions-framework';
import cors from 'cors';
import { drive, getParentFolderName } from './drive.service';
import { getMusicMetadata } from './metadata.service';
import { getExistingFileMetadata, batchWriteSongs, deleteSongs } from './firestore.service';
import { SongMetadata } from './models';

admin.initializeApp();

const DRIVE_FOLDER_ID = '1VxClhCDuH0fX4Fkze3yJmkWQkYiutxOs';
const corsMiddleware = cors({ origin: true });

async function processDriveFolder(folderId: string, existingFirestoreMetadata: Map<string, { modifiedTime: string }>, userId?: string): Promise<Set<string>> {
    let pageToken: string | null = null;
    const currentDriveFileIds = new Set<string>();
    const foldersToProcess: string[] = [folderId];

    while (foldersToProcess.length > 0) {
        const currentFolderId = foldersToProcess.shift()!;
        do {
            const response: any = await drive.files.list({
                q: `'${currentFolderId}' in parents and (mimeType='audio/mpeg' or mimeType='audio/flac' or mimeType='audio/x-flac' or mimeType='audio/wav' or mimeType='application/vnd.google-apps.folder')`,
                fields: 'nextPageToken, files(id, name, mimeType, size, parents, modifiedTime)',
                pageToken: pageToken || undefined,
                pageSize: 200, // Process in smaller batches
            });

            const files = response.data.files || [];
            const songsToWrite: SongMetadata[] = [];

            for (const file of files) {
                currentDriveFileIds.add(file.id!);

                if (file.mimeType === 'application/vnd.google-apps.folder') {
                    foldersToProcess.push(file.id!);
                    continue;
                }

                const existingMetadata = existingFirestoreMetadata.get(file.id!);
                if (!existingMetadata || (file.modifiedTime > existingMetadata.modifiedTime)) {
                    const songMetadata: Partial<SongMetadata> = {
                        id: file.id!,
                        name: file.name!,
                        mimeType: file.mimeType!,
                        size: file.size,
                        parents: file.parents || [],
                        modifiedTime: file.modifiedTime!,
                        isFolder: false,
                    };

                    songMetadata.inFolderName = await getParentFolderName(file.id!);
                    const id3Data = await getMusicMetadata(file.id!);
                    
                    songsToWrite.push({ ...songMetadata, ...id3Data } as SongMetadata);
                }
            }

            if (songsToWrite.length > 0) {
                console.log(`Writing ${songsToWrite.length} songs to Firestore.`);
                await batchWriteSongs(songsToWrite, userId);
            }

            pageToken = response.data.nextPageToken;
        } while (pageToken);
    }
    return currentDriveFileIds;
}

export async function syncGoogleDriveToFirestore(rootFolderId: string, userId?: string): Promise<void> {
    console.log(`Starting sync for user: ${userId || 'global'} from root folder: ${rootFolderId}`);

    try {
        const existingFirestoreMetadata = await getExistingFileMetadata(userId);
        const existingFirestoreFileIds = new Set(existingFirestoreMetadata.keys());

        console.log(`Found ${existingFirestoreFileIds.size} existing documents in Firestore.`);

        const currentDriveFileIds = await processDriveFolder(rootFolderId, existingFirestoreMetadata, userId);

        console.log(`Found ${currentDriveFileIds.size} files/folders in Google Drive.`);

        const filesToDelete = [...existingFirestoreFileIds].filter(id => !currentDriveFileIds.has(id));

        if (filesToDelete.length > 0) {
            console.log(`Deleting ${filesToDelete.length} songs from Firestore.`);
            await deleteSongs(filesToDelete, userId);
        }

    } catch (error) {
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
        } catch (error) {
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
      
      const fileStream = await drive.files.get(
        { fileId: fileId, alt: 'media' },
        { responseType: 'stream' }
      );

      fileStream.data.on('error', (err) => {
          console.error('Error during file stream:', err);
          res.status(500).send('Error streaming the file.');
        }).pipe(res);

    } catch (error) {
      console.error(`Error streaming file ${fileId}:`, error);
      res.status(500).send('Failed to stream the file.');
    }
  });
});