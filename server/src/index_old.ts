// --- File: index.ts ---
// This is the main file for your Google Cloud Function.

import * as functions from '@google-cloud/functions-framework';
import { google } from 'googleapis';
import cors from 'cors';

// --- Configuration ---
// IMPORTANT: Replace this with the ID of the folder you created in Google Drive.
//const DRIVE_FOLDER_ID = '1VxClhCDuH0fX4Fkze3yJmkWQkYiutxOs';   //MP3s root

const DRIVE_FOLDER_ID = '19rCsfU1J6fJdIynDh73kPimkce1tXlxj';  //Digitally Imported 


// --- Initialize CORS Middleware ---
// This allows your frontend application to make requests to this function.
// For production, you should restrict the origin to your actual domain.
const corsMiddleware = cors({ origin: true });

// --- Google Drive API Setup ---
// The GoogleAuth client will automatically find and use the service account
// credentials when deployed to Google Cloud.
const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/drive.readonly'],
});
const drive = google.drive({ version: 'v3', auth });

/**
 * An HTTP-triggered Cloud Function to list audio files from a specific Google Drive folder.
 * It returns a JSON array of files with their id and name.
 */
  async function fetchFilesRecursively(folderId: string) {
    let allFiles: any[] = [];
    let pageToken = null;
    
    try {
      do {
        const response: any = await drive.files.list({
          q: `'${folderId}' in parents and (mimeType='audio/mpeg' or mimeType='audio/flac' or mimeType='audio/x-flac' or mimeType='audio/wav' or mimeType='application/vnd.google-apps.folder')`, // Explicitly define the type for 'response'
          fields: 'nextPageToken, files(id, name, mimeType, size, parents)',
          pageToken: pageToken,
          orderBy: 'name',
          pageSize: 1000 // Max page size for efficiency
        });

        const files = response.data.files || [];
        allFiles = allFiles.concat(files);
        pageToken = response.data.nextPageToken;

        // Recursively search sub-folders
        for (const file of files) {
          if (file.mimeType === 'application/vnd.google-apps.folder') {
            const subFolderFiles = await fetchFilesRecursively(file.id);
            allFiles = allFiles.concat(subFolderFiles);
          }
        }
      } while (pageToken);
    } catch (error) {
      console.error(`Error fetching files from folder ${folderId}:`, error);
      // Optionally, rethrow the error or handle it as needed
      throw error;
    }

    return allFiles;
  }


functions.http('getMusicList', async (req, res) => {
  // Use the CORS middleware
 // let pageToken = null;

  corsMiddleware(req, res, async () => {
    try {
      console.log(`Fetching files from folder: ${DRIVE_FOLDER_ID}`);
      const fileList = await fetchFilesRecursively(DRIVE_FOLDER_ID);
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
