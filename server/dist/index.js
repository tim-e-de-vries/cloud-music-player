"use strict";
// --- File: index.ts ---
// This is the main file for your Google Cloud Function.
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
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const functions = __importStar(require("@google-cloud/functions-framework"));
const googleapis_1 = require("googleapis");
const cors_1 = __importDefault(require("cors"));
// --- Configuration ---
// IMPORTANT: Replace this with the ID of the folder you created in Google Drive.
const DRIVE_FOLDER_ID = '1VxClhCDuH0fX4Fkze3yJmkWQkYiutxOs';
// --- Initialize CORS Middleware ---
// This allows your frontend application to make requests to this function.
// For production, you should restrict the origin to your actual domain.
const corsMiddleware = (0, cors_1.default)({ origin: true });
// --- Google Drive API Setup ---
// The GoogleAuth client will automatically find and use the service account
// credentials when deployed to Google Cloud.
const auth = new googleapis_1.google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
});
const drive = googleapis_1.google.drive({ version: 'v3', auth });
/**
 * An HTTP-triggered Cloud Function to list audio files from a specific Google Drive folder.
 * It returns a JSON array of files with their id and name.
 */
functions.http('getMusicList', async (req, res) => {
    // Use the CORS middleware
    corsMiddleware(req, res, async () => {
        try {
            console.log(`Fetching files from folder: ${DRIVE_FOLDER_ID}`);
            const fileList = await drive.files.list({
                q: `'${DRIVE_FOLDER_ID}' in parents and (mimeType='audio/mpeg' or mimeType='audio/flac' or mimeType='audio/wav')`,
                fields: 'files(id, name)',
                orderBy: 'name', // Sort files alphabetically
            });
            if (!fileList.data.files || fileList.data.files.length === 0) {
                res.status(404).send('No audio files found in the specified folder.');
                return;
            }
            console.log(`Found ${fileList.data.files.length} files.`);
            res.status(200).json(fileList.data.files);
        }
        catch (error) {
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
            const fileStream = await drive.files.get({ fileId: fileId, alt: 'media' }, { responseType: 'stream' });
            // Pipe the stream from Google Drive directly to the client's response
            fileStream.data
                .on('error', (err) => {
                console.error('Error during file stream:', err);
                res.status(500).send('Error streaming the file.');
            })
                .pipe(res);
        }
        catch (error) {
            console.error(`Error streaming file ${fileId}:`, error);
            res.status(500).send('Failed to stream the file.');
        }
    });
});
