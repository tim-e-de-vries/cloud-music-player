import { parseStream } from 'music-metadata';
import { drive } from './drive.service';
import { Id3Metadata, LyricsApiResponse } from './models';

const CLOUD_FUNCTION_URL = "https://us-central1-wireguard-283822.cloudfunctions.net/get-youtube-music-lyrics";

async function getLyricsFromCloudFunction(artist: string, trackTitle: string): Promise<LyricsApiResponse | undefined> {
    try {
        const response = await fetch(CLOUD_FUNCTION_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ artist, trackTitle }),
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
            console.error(`Error calling Cloud Function: ${response.status} - ${errorData.message}`);
            return undefined;
        }
        return response.json();
    } catch (error) {
        console.error(`Network or unexpected error while fetching lyrics:`, error);
        return undefined;
    }
}

export async function getMusicMetadata(fileId: string): Promise<Id3Metadata> {
    const fileData: Id3Metadata = {};
    try {
        const fileStreamResponse = await drive.files.get(
            { fileId, alt: 'media' },
            { responseType: 'stream' }
        );

        const metadata = await parseStream(fileStreamResponse.data);

        fileData.Artist = metadata.common.artist || 'Unknown Artist';
        fileData.Album = metadata.common.album || 'Unknown Album';
        fileData.Title = metadata.common.title || 'Unknown Title';
        
        if (!metadata.common.lyrics || metadata.common.lyrics.length === 0) {
            const lyricResponse = await getLyricsFromCloudFunction(fileData.Artist, fileData.Title);
            if (lyricResponse) {
                fileData.Lyrics = lyricResponse.lyrics || '';
                fileData.ImagePath = lyricResponse.artwork || '';
            }
        } else {
            fileData.Lyrics = metadata.common.lyrics[0].text;
        }

    } catch (error: any) {
        console.warn(`Could not extract metadata for ${fileId}:`, error.message);
        fileData.Artist = 'N/A';
        fileData.Album = 'N/A';
    }
    return fileData;
}