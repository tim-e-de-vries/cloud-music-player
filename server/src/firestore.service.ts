import * as admin from 'firebase-admin';
import { SongMetadata } from './models';

// Remove the db initialization from here
// const db = admin.firestore(); 

const SONGS_COLLECTION = 'songs';
const DELETIONS_COLLECTION = 'deletedSongs';
const BATCH_SIZE = 400;

export async function getExistingFileMetadata(userId?: string): Promise<Map<string, { modifiedTime: string }>> {
    const db = admin.firestore(); // Get the db instance here
    const existingMetadata = new Map<string, { modifiedTime: string }>();
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

export async function batchWriteSongs(songs: SongMetadata[], userId?: string) {
    const db = admin.firestore(); // Get the db instance here
    let batch = db.batch();
    let writeCount = 0;

    for (const song of songs) {
        const docRef = db.collection(SONGS_COLLECTION).doc(song.id);
        const dataToSet: SongMetadata = {
            ...song,
            userId: userId ,
            _lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        };
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

export async function deleteSongs(songIds: string[], userId?: string) {
    const db = admin.firestore(); // Get the db instance here
    let batch = db.batch();
    let deleteCount = 0;

    for (const songId of songIds) {
        const docRef = db.collection(SONGS_COLLECTION).doc(songId);
        batch.delete(docRef);

        const deletedDocRef = db.collection(DELETIONS_COLLECTION).doc(songId);
        batch.set(deletedDocRef, {
            id: songId,
            userId: userId ,
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