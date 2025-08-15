import * as admin from 'firebase-admin';

export interface SongMetadata {
    id: string; // Google Drive File ID - This will be the Firestore Document ID
    name: string;
    mimeType: string;
    size?: string | null | undefined;
    parents?: string[];
    inFolderName?: string;
    modifiedTime: string;
    isFolder: boolean;
    userId?: string;
    _lastUpdated: admin.firestore.FieldValue;
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

export interface Id3Metadata {
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

export interface LyricsApiResponse {
    artist: string;
    artwork: string | null;
    lyrics: string | null | undefined;
    message: string;
    trackTitle: string;
}