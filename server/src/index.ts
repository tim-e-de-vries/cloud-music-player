import * as admin from 'firebase-admin';
import { google, drive_v3 } from 'googleapis';
import * as functions from '@google-cloud/functions-framework';
import cors from 'cors';
//import { parseStream, IAudioMetadata, IPicture } from 'music-metadata';  
//import { parseStream, ILyricsTag} from 'music-metadata';  
import { parseStream} from 'music-metadata';  


// Initialize Firebase Admin SDK and Google Drive API (as above)
admin.initializeApp();
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/drive.readonly'],
});

const drive = google.drive({ version: 'v3', auth });
const DRIVE_FOLDER_ID = '1VxClhCDuH0fX4Fkze3yJmkWQkYiutxOs';   //MP3s root
//const DRIVE_FOLDER_ID = '19rCsfU1J6fJdIynDh73kPimkce1tXlxj';   //Digitally Imported
//const mm = require('music-metadata'); // <--- NEW IMPORT: You need to install 'music-metadata' in your Cloud Function's dependencies.


const CLOUD_FUNCTION_URL = "https://us-central1-wireguard-283822.cloudfunctions.net/get-youtube-music-lyrics";

// Define the interface for your song metadata


interface SongMetadata {
  id: string; // Google Drive File ID - This will be the Firestore Document ID
  name: string;
  mimeType: string;
  size?: string | null | undefined; // Note: Google Drive API returns size as string
  parents?: string[];
  inFolderName?: string
  modifiedTime: string; // Crucial for upsert strategy - always expected
  isFolder: boolean; // Flag to easily distinguish folders
  // Add any other relevant metadata you want to store
  userId?: string; // If you're scoping per-user
  _lastUpdated: admin.firestore.FieldValue; // Firestore timestamp for when we last updated this record
  Title?: string;
  Artist?: string;
  Album?: string;
  Track?: string;
  Year?: string;
  Length?: string;
  Path?: string;
  ImagePath?: string;
  Lyrics?: string;
  Genre?: string; 
}
interface id3metadata{
  Title?: string;
  Artist?: string;
  Album?: string;
  Track?: string;
  Year?: string;
  Length?: string;
  Path?: string;
  ImagePath?: string;
  Lyrics?: string;
  Genre?: string; 
}
interface LyricsApiResponse {
  artist: string;
  artwork: string | null;
  lyrics: string | null | undefined;
  message: string;
  trackTitle: string;
}

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
const corsMiddleware = cors({ origin: true });



async function fetchDriveFilesRecursively(folderId: string): Promise<SongMetadata[]> {
  let allFiles: SongMetadata[] = [];
  let pageToken: string | null = null;
  type DriveFile = drive_v3.Schema$File;
//   const query:string | undefined =  `'${folderId}' in parents and (mimeType contains 'audio/' or mimeType='application/vnd.google-apps.folder')`;
 
  try {
    do {
        const response: any =  await drive.files.list({
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

      const files: DriveFile[] = response.data.files || [];

      const formattedFiles: SongMetadata[] = await Promise.all(files.map(async file => {
        if (file.mimeType === 'application/vnd.google-apps.folder') {
             const songMetadata: SongMetadata = {
              id: file.id!,
              name: file.name!,
              mimeType: file.mimeType!,
              modifiedTime: file.modifiedTime!, // Ensure this is always present
              isFolder: file.mimeType === 'application/vnd.google-apps.folder',
              _lastUpdated: admin.firestore.FieldValue.serverTimestamp() // Will be set later during Firestore  write
             };
          return songMetadata;
         };
        const songMetadata: SongMetadata = {
          id: file.id!,
          name: file.name!,
          mimeType: file.mimeType!,
          size: file.size, // Will be undefined for folders
          parents: file.parents || [],
          inFolderName:  await getParentFolderName(file.id!),
          modifiedTime: file.modifiedTime!, // Ensure this is always present
          isFolder: file.mimeType === 'application/vnd.google-apps.folder',
          _lastUpdated: admin.firestore.FieldValue.serverTimestamp() // Will be set later during Firestore  write
        };
        let respon: id3metadata = await getMusicMetadata(file.id!);
        songMetadata.Album = respon.Album;
        songMetadata.Artist = respon.Artist;
        songMetadata.Title = respon.Title;
        songMetadata.Lyrics = respon.Lyrics;
        songMetadata.ImagePath = respon.ImagePath;
        return songMetadata;
      }));
      console.log(`Google Drive responded with ${formattedFiles.length} files`);
      allFiles = allFiles.concat(formattedFiles);
      pageToken = response.data.nextPageToken;

      // Recursively search sub-folders
      for (const file of formattedFiles) { // Iterate over formatted files
        if (file.mimeType === 'application/vnd.google-apps.folder') {
          const subFolderFiles = await fetchDriveFilesRecursively(file.id);
          allFiles = allFiles.concat(subFolderFiles);
        }
      }
    } while (pageToken);
  } catch (error) {
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
export async function syncGoogleDriveToFirestore(rootFolderId: string, userId?: string): Promise<void> {
  console.log(`Starting sync for user: ${userId || 'global'} from root folder: ${rootFolderId}`);

  let existingFirestoreFileIds: Set<string> = new Set();
  let firestoreBatch = db.batch();
  let writeCount = 0;
  const BATCH_SIZE = 400; // Max 500 operations per batch, leave some room for safety

  try {
    // 1. Fetch all existing file IDs from Firestore for comparison
    const existingDocsSnapshot = await db.collection(SONGS_COLLECTION)
      .where('userId', '==', userId || null) // Query by userId if provided
      .select('id', 'modifiedTime') // Only fetch what's needed for comparison
      .get();

    const existingFirestoreMetadata: Map<string, { modifiedTime: string; lastUpdated: admin.firestore.Timestamp }> = new Map();
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
    const currentDriveFileIds = new Set<string>();

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
        const dataToSet: SongMetadata = {
          ...file,
          userId: userId, // Attach userId
          _lastUpdated: admin.firestore.FieldValue.serverTimestamp() // Our timestamp
        };
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

  } catch (error) {
    console.error(`Error syncing Google Drive to Firestore for user ${userId || 'global'}:`, error);
    throw error;
  }

  console.log(`Sync complete for user: ${userId || 'global'}.`);
}
async function getMusicMetadata(fileId: string): Promise<id3metadata> {
  let fileData: id3metadata = { Title: ''  }; // Initialize with a default or empty object
  try {
      const fileStreamResponse = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream' }
      );

      // Parse metadata from the stream
      const metadata = await parseStream(fileStreamResponse.data);

      // Add common metadata fields to the fileData object
      fileData.Artist = metadata.common.artist || 'Unknown Artist';
      fileData.Album = metadata.common.album || 'Unknown Album';
      fileData.Title = metadata.common.title || 'Unknown Title'; // Use parsed title or original     fileData.Lyrics = ""; // Initialize fileData.Lyrics as an empty string
      fileData.Lyrics = ""; // Initialize fileData.Lyrics as an empty string
      // const lyrics: ILyricsTag[] = metadata.common.lyrics || [];
      // if (lyrics.length > 0) {
      //     lyrics.forEach((l: ILyricsTag, index: number) => {
      //         // Append the lyric text and a newline character
      //         fileData.Lyrics += l.text + '\n';
      //   });
      // if (fileData.Lyrics.length > 0) {
      //     fileData.Lyrics = fileData.Lyrics.trimEnd(); // Removes trailing whitespace, including newlines
      // }
      if (fileData.Lyrics.length == 0) {
        const lyricresp =  await getLyricsFromCloudFunction(fileData.Artist, fileData.Title);
        if (lyricresp) {
          fileData.Lyrics = lyricresp.lyrics || '';
          fileData.ImagePath = lyricresp.artwork || '';
        }
      }
    }
  catch (error: any) { // Explicitly type error as 'any' or 'unknown'
  console.warn(`Could not extract metadata for ${fileId}:`, error.message);
  // Fallback if metadata extraction fails
  fileData.Artist = 'N/A';
  fileData.Album = 'N/A';
  // fileData.Title will remain undefined if not set here, or you can set it to a default
}
return fileData;
}
async function getParentFolderName(fileId: string): Promise<string> {
  const parentFolderNames: string[] = [];
  try {
    // Step 1: Get the parent IDs of the file
    const fileMetadataRes = await drive.files.get({
      fileId: fileId,
      fields: 'parents',
    });

    const parentIds = fileMetadataRes.data.parents || [];
//    console.log(`Parent IDs for file '${fileId}': ${parentIds}`);
// Step 2: Get the name of each parent folder
    for (const parentId of parentIds) {
      try {
        const folderMetadataRes = await drive.files.get({
          fileId: parentId,
          fields: 'name, mimeType',
        });

        if (folderMetadataRes.data.mimeType === 'application/vnd.google-apps.folder') {
          parentFolderNames.push(folderMetadataRes.data.name as string);
        } else {
          console.log(`Parent '${parentId}' is not a folder (mimeType: ${folderMetadataRes.data.mimeType}).`);
        }
      } catch (error) {
        console.error(`An error occurred while fetching parent folder '${parentId}':`, error);
      }
    }

    return  parentFolderNames[0] || '' ;

  } catch (error) {
    console.error('An error occurred in getParentFolderName:', error);
    return  parentFolderNames[0] || '' ;

  }
}
async function getLyricsFromCloudFunction(
  artist: string,
  trackTitle: string
): Promise<LyricsApiResponse | undefined> {
  try {
    const response = await fetch(CLOUD_FUNCTION_URL, {
      method: "POST", // Or 'GET' if you prefer query parameters, but POST with JSON is generally cleaner for data.
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        artist: artist,
        trackTitle: trackTitle,
      }),
    });

    // Check if the request was successful (status code 2xx)
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
      console.error(`Error calling Cloud Function: ${response.status} - ${errorData.message}`);
      // Throw an error to be caught by the caller
      throw new Error(`Failed to fetch lyrics: ${errorData.message || response.statusText}`);
    }

    const data: LyricsApiResponse = await response.json();

    if (data.lyrics) {
      console.log(`Successfully fetched lyrics for ${artist} - ${trackTitle}`);
    } else {
      console.warn(`Lyrics not found for ${artist} - ${trackTitle}. Message: ${data.message}`);
    }
    return data;
  } catch (error) {
    console.error(`Network or unexpected error while fetching lyrics:`, error);
    // You might want to re-throw or return null based on your error handling strategy
    throw error; // Re-throw to propagate the error
  }
}

functions.http('fetchDriveFilesRecursively', async (req, res) => {
  // Use the CORS middleware
 // let pageToken = null;

  corsMiddleware(req, res, async () => {
    try {
      const { folderId } = req.query; // Get folderId from query parameters

      // Use the provided folderId, or fall back to DRIVE_FOLDER_ID if not provided
      const targetFolderId = typeof folderId === 'string' ? folderId : DRIVE_FOLDER_ID;

      console.log(`Fetching files from folder: ${targetFolderId}`);
      const fileList = await fetchDriveFilesRecursively(targetFolderId);
      if (!fileList || fileList.length === 0) {
        res.status(404).send('No audio files found in the specified folder.');
        return;
      }
      
      console.log(`Found ${fileList.length} files.`);
      res.status(200).json(fileList);

    } catch (error) {
      console.error('Error fetching file list from Google Drive:', error);
      res.status(500).send('Failed to retrieve file list from Google Drive.');
    }
  });
});


/**
 * An HTTP-triggered Cloud Function to stream a specific audio file from Google Drive.
 * The file ID is passed as a query parameter (e.g., /streamFile?fileId=xxxx)
 */
functions.http('streamMusicFile', async (req, res) => {
  corsMiddleware(req, res, async () => {
    const { fileId } = req.query;

    if (!fileId || typeof fileId !== 'string') {
      res.status(400).send('File ID is required.');
      return;
    }

    try {
      console.log(`Streaming file with ID: ${fileId}`);
      
      // Set headers for streaming audio
      res.setHeader('Content-Type', 'audio/mpeg'); // Adjust if you use other formats
      res.setHeader('Accept-Ranges', 'bytes');
      
      // Get the file as a readable stream
      const fileStream = await drive.files.get(
        { fileId: fileId, alt: 'media' },
        { responseType: 'stream' }
      );

      // Pipe the stream from Google Drive directly to the client's response
      fileStream.data
        .on('error', (err) => {
          console.error('Error during file stream:', err);
          res.status(500).send('Error streaming the file.');
        })
        .pipe(res);

    } catch (error) {
      console.error(`Error streaming file ${fileId}:`, error);
      res.status(500).send('Failed to stream the file.');
    }
  });
});
functions.http('syncGoogleDriveToFirestore', async (req, res) => {
  // Use the CORS middleware
 // let pageToken = null;

  corsMiddleware(req, res, async () => {
    try {
      const { folderId } = req.query; // Get folderId from query parameters

      // Use the provided folderId, or fall back to DRIVE_FOLDER_ID if not provided
      const targetFolderId = typeof folderId === 'string' ? folderId : DRIVE_FOLDER_ID;

      console.log(`Fetching files from folder: ${targetFolderId}`);
      const fileList:any = await syncGoogleDriveToFirestore(targetFolderId);
      if (!fileList || fileList.length === 0) {
        res.status(404).send('No audio files found in the specified folder.');
        return;
      }
      
      console.log(`Found ${fileList.length} files.`);
      res.status(200).json(fileList);

    } catch (error) {
      console.error('Error fetching file list from Google Drive:', error);
      res.status(500).send('Failed to retrieve file list from Google Drive.');
    }
  });
});