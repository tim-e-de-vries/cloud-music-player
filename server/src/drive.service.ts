import { google } from 'googleapis';

const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
});

export const drive = google.drive({ version: 'v3', auth });

export async function getParentFolderName(fileId: string): Promise<string> {
    try {
        const fileMetadataRes = await drive.files.get({
            fileId: fileId,
            fields: 'parents',
        });

        const parentIds = fileMetadataRes.data.parents || [];
        if (parentIds.length > 0) {
            const folderMetadataRes = await drive.files.get({
                fileId: parentIds[0],
                fields: 'name',
            });
            return folderMetadataRes.data.name || '';
        }
        return '';
    } catch (error) {
        console.error(`Error getting parent folder name for file ${fileId}:`, error);
        return '';
    }
}