"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.drive = void 0;
exports.getParentFolderName = getParentFolderName;
const googleapis_1 = require("googleapis");
const auth = new googleapis_1.google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
});
exports.drive = googleapis_1.google.drive({ version: 'v3', auth });
async function getParentFolderName(fileId) {
    try {
        const fileMetadataRes = await exports.drive.files.get({
            fileId: fileId,
            fields: 'parents',
        });
        const parentIds = fileMetadataRes.data.parents || [];
        if (parentIds.length > 0) {
            const folderMetadataRes = await exports.drive.files.get({
                fileId: parentIds[0],
                fields: 'name',
            });
            return folderMetadataRes.data.name || '';
        }
        return '';
    }
    catch (error) {
        console.error(`Error getting parent folder name for file ${fileId}:`, error);
        return '';
    }
}
//# sourceMappingURL=drive.service.js.map