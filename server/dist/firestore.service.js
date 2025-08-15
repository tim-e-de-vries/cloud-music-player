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
Object.defineProperty(exports, "__esModule", { value: true });
exports.getExistingFileMetadata = getExistingFileMetadata;
exports.batchWriteSongs = batchWriteSongs;
exports.deleteSongs = deleteSongs;
const admin = __importStar(require("firebase-admin"));
// Remove the db initialization from here
// const db = admin.firestore(); 
const SONGS_COLLECTION = 'songs';
const DELETIONS_COLLECTION = 'deletedSongs';
const BATCH_SIZE = 400;
async function getExistingFileMetadata(userId) {
    const db = admin.firestore(); // Get the db instance here
    const existingMetadata = new Map();
    const queryUserIdValue = userId === undefined ? null : userId;
    const snapshot = await db.collection(SONGS_COLLECTION)
        .where('userId', '==', queryUserIdValue)
        .select('modifiedTime')
        .get();
    snapshot.forEach(doc => {
        existingMetadata.set(doc.id, { modifiedTime: doc.data().modifiedTime });
    });
    return existingMetadata;
}
async function batchWriteSongs(songs, userId) {
    const db = admin.firestore(); // Get the db instance here
    let batch = db.batch();
    let writeCount = 0;
    for (const song of songs) {
        const docRef = db.collection(SONGS_COLLECTION).doc(song.id);
        const dataToSet = Object.assign(Object.assign({}, song), { userId: userId, _lastUpdated: admin.firestore.FieldValue.serverTimestamp() });
        batch.set(docRef, dataToSet, { merge: true });
        writeCount++;
        if (writeCount >= BATCH_SIZE) {
            await batch.commit();
            batch = db.batch();
            writeCount = 0;
        }
    }
    if (writeCount > 0) {
        await batch.commit();
    }
}
async function deleteSongs(songIds, userId) {
    const db = admin.firestore(); // Get the db instance here
    let batch = db.batch();
    let deleteCount = 0;
    for (const songId of songIds) {
        const docRef = db.collection(SONGS_COLLECTION).doc(songId);
        batch.delete(docRef);
        const deletedDocRef = db.collection(DELETIONS_COLLECTION).doc(songId);
        batch.set(deletedDocRef, {
            id: songId,
            userId: userId,
            deletedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        deleteCount += 2; // two operations
        if (deleteCount >= BATCH_SIZE - 1) {
            await batch.commit();
            batch = db.batch();
            deleteCount = 0;
        }
    }
    if (deleteCount > 0) {
        await batch.commit();
    }
}
//# sourceMappingURL=firestore.service.js.map