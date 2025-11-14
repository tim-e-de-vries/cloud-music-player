// File: src/app.ts
// This is the main TypeScript file for the frontend.
// --- Configuration ---
// IMPORTANT: Replace these with the URLs of your deployed Google Cloud Functions.
const GET_LIST_URL = 'https://us-central1-wireguard-283822.cloudfunctions.net/getMusicList';
const STREAM_URL_BASE = 'https://us-central1-wireguard-283822.cloudfunctions.net/streamMusicFile';
// --- DOM Elements ---
const UIElements = {
    loadingContainer: document.getElementById('loading-container'),
    playerContainer: document.getElementById('player-container'),
    errorContainer: document.getElementById('error-container'),
    errorMessage: document.getElementById('error-message'),
    audioPlayer: document.getElementById('audio-player'),
    playPauseButton: document.getElementById('play-pause-button'),
    playIcon: document.getElementById('play-icon'),
    pauseIcon: document.getElementById('pause-icon'),
    prevButton: document.getElementById('prev-button'),
    nextButton: document.getElementById('next-button'),
    currentSongTitle: document.getElementById('current-song-title'),
    playlistElement: document.getElementById('playlist'),
    // New elements for seek slider
    seekSlider: document.getElementById('seekSlider'),
    currentTimeElement: document.getElementById('currentTime'),
    durationElement: document.getElementById('duration'),
};
// --- Application State ---
// Simple LRU cache for Blob object URLs. Automatically revokes URLs on eviction.
class BlobUrlCache {
    constructor(maxItems = 10, maxBytes = 50 * 1024 * 1024) {
        this.maxItems = maxItems;
        this.maxBytes = maxBytes;
        this.map = new Map();
    }
    has(id) {
        return this.map.has(id);
    }
    get(id) {
        const entry = this.map.get(id);
        if (!entry)
            return undefined;
        entry.lastAccess = Date.now();
        // move to end to mark as recently used
        this.map.delete(id);
        this.map.set(id, entry);
        return entry.url;
    }
    set(id, url, size = 0) {
        // If replacing existing, revoke old URL first
        const existing = this.map.get(id);
        if (existing && existing.url !== url) {
            try {
                URL.revokeObjectURL(existing.url);
            }
            catch (_) { }
            this.map.delete(id);
        }
        this.map.set(id, { url, size, lastAccess: Date.now() });
        this.evictIfNeeded();
    }
    delete(id) {
        const e = this.map.get(id);
        if (!e)
            return;
        try {
            URL.revokeObjectURL(e.url);
        }
        catch (_) { }
        this.map.delete(id);
    }
    clear() {
        for (const e of this.map.values()) {
            try {
                URL.revokeObjectURL(e.url);
            }
            catch (_) { }
        }
        this.map.clear();
    }
    keys() { return Array.from(this.map.keys()); }
    setProtected(id) { this.protectedId = id; }
    totalBytes() {
        let sum = 0;
        for (const v of this.map.values())
            sum += v.size || 0;
        return sum;
    }
    evictIfNeeded() {
        // Evict while limits exceeded
        while ((this.map.size > this.maxItems) || (this.totalBytes() > this.maxBytes)) {
            // least-recently-used = first item in Map iteration
            const firstKey = this.map.keys().next().value;
            if (!firstKey)
                break;
            // Protect the currently playing id from eviction
            if (this.protectedId && firstKey === this.protectedId) {
                // move protected to end and continue
                const prot = this.map.get(firstKey);
                this.map.delete(firstKey);
                this.map.set(firstKey, prot);
                // find next key
                const nextKey = this.map.keys().next().value;
                if (!nextKey || nextKey === firstKey)
                    break;
            }
            const entryKey = this.map.keys().next().value;
            if (!entryKey)
                break;
            const entry = this.map.get(entryKey);
            try {
                URL.revokeObjectURL(entry.url);
            }
            catch (_) { }
            this.map.delete(entryKey);
        }
    }
}
class MusicPlayer {
    constructor() {
        this.playlist = [];
        this.currentIndex = -1;
        this.isPlaying = false;
        // Replace simple Map with an LRU cache that revokes object URLs on eviction
        this.audioCache = new BlobUrlCache(10, 50 * 1024 * 1024); // 10 items, 50MB
        this.init();
        // Revoke any cached object URLs on unload to free memory
        if (typeof window !== 'undefined') {
            window.addEventListener('beforeunload', () => this.audioCache.clear());
            window.addEventListener('pagehide', () => this.audioCache.clear());
        }
    }
    async init() {
        try {
            // Fetch the playlist from the proxy
            const response = await fetch(GET_LIST_URL);
            if (!response.ok) {
                throw new Error(`Server responded with ${response.status}: ${await response.text()}`);
            }
            this.playlist = await response.json();
            if (this.playlist.length === 0) {
                this.showError('No songs found in your Google Drive folder.');
                return;
            }
            this.renderPlaylist();
            this.attachEventListeners();
            this.showPlayer();
        }
        catch (error) {
            console.error('Initialization failed:', error);
            this.showError('Could not load music library. Check the proxy URL and function logs.');
        }
    }
    showPlayer() {
        UIElements.loadingContainer.classList.add('hidden');
        UIElements.playerContainer.classList.remove('hidden');
    }
    showError(message) {
        UIElements.loadingContainer.classList.add('hidden');
        UIElements.playerContainer.classList.add('hidden');
        UIElements.errorMessage.textContent = message;
        UIElements.errorContainer.classList.remove('hidden');
    }
    renderPlaylist() {
        UIElements.playlistElement.innerHTML = '';
        this.playlist.forEach((song, index) => {
            const songItem = document.createElement('div');
            songItem.className = 'song-item p-3 cursor-pointer hover:bg-gray-200 border-b last:border-b-0';
            songItem.textContent = song.name.replace(/\.(mp3|flac|wav)$/i, ''); // Clean up name
            songItem.dataset.index = index.toString();
            songItem.onclick = () => this.playSong(index);
            UIElements.playlistElement.appendChild(songItem);
        });
    }
    async playSong(index) {
        if (index < 0 || index >= this.playlist.length) {
            return;
        }
        this.currentIndex = index;
        const song = this.playlist[this.currentIndex];
        UIElements.currentSongTitle.textContent = song.name.replace(/\.(mp3|flac|wav)$/i, '');
        this.updatePlaylistUI();
        try {
            let songUrl;
            // Check cache first
            if (this.audioCache.has(song.id)) {
                songUrl = this.audioCache.get(song.id);
                console.log(`Playing ${song.name} from cache.`);
            }
            else {
                // Not in cache, use direct stream URL
                songUrl = `${STREAM_URL_BASE}?fileId=${song.id}`;
                console.log(`Streaming ${song.name} directly.`);
            }
            // Protect currently playing id from eviction
            this.audioCache.setProtected(song.id);
            UIElements.audioPlayer.src = songUrl;
            await UIElements.audioPlayer.play();
            this.isPlaying = true;
            this.updatePlayPauseIcon();
            // Pre-cache surrounding songs
            this.updateCache();
        }
        catch (error) {
            console.error(`Error playing song ${song.name}:`, error);
            this.showError(`Could not play ${song.name}.`);
            this.isPlaying = false;
            this.updatePlayPauseIcon();
        }
    }
    togglePlayPause() {
        if (this.currentIndex === -1 && this.playlist.length > 0) {
            // If no song has been played yet, start with the first one
            this.playSong(0);
        }
        else {
            if (this.isPlaying) {
                UIElements.audioPlayer.pause();
            }
            else {
                UIElements.audioPlayer.play();
            }
            this.isPlaying = !this.isPlaying;
            this.updatePlayPauseIcon();
        }
    }
    playNext() {
        const nextIndex = (this.currentIndex + 1) % this.playlist.length;
        this.playSong(nextIndex);
    }
    playPrev() {
        const prevIndex = (this.currentIndex - 1 + this.playlist.length) % this.playlist.length;
        this.playSong(prevIndex);
    }
    updatePlayPauseIcon() {
        if (this.isPlaying) {
            UIElements.playIcon.classList.add('hidden');
            UIElements.pauseIcon.classList.remove('hidden');
        }
        else {
            UIElements.playIcon.classList.remove('hidden');
            UIElements.pauseIcon.classList.add('hidden');
        }
    }
    updatePlaylistUI() {
        const items = UIElements.playlistElement.querySelectorAll('.song-item');
        items.forEach((item, index) => {
            if (index === this.currentIndex) {
                item.classList.add('active');
            }
            else {
                item.classList.remove('active');
            }
        });
    }
    updateProgressBar() {
        const { duration, currentTime } = UIElements.audioPlayer;
        // Update seek slider
        if (!isNaN(duration) && (isFinite(duration))) {
            UIElements.seekSlider.max = duration.toString();
            UIElements.seekSlider.value = currentTime.toString();
        }
        else {
            UIElements.seekSlider.max = "N/A";
            UIElements.seekSlider.value = ":Streaming";
        }
        // Update time display
        UIElements.currentTimeElement.textContent = this.formatTime(currentTime);
        if (!isNaN(duration) && (isFinite(duration))) {
            UIElements.durationElement.textContent = this.formatTime(duration);
        }
        else {
            UIElements.durationElement.textContent = "N/A:Streaming";
        }
    }
    formatTime(seconds) {
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
    }
    /**
     * Caching logic: Fetches and caches the next 5 and previous 5 songs.
     */
    async updateCache() {
        const cacheRange = 5;
        const songsToCache = [];
        // Add next songs to cache queue
        for (let i = 1; i <= cacheRange; i++) {
            const nextIndex = (this.currentIndex + i) % this.playlist.length;
            if (nextIndex !== this.currentIndex)
                songsToCache.push(this.playlist[nextIndex]);
        }
        // Add previous songs to cache queue
        for (let i = 1; i <= cacheRange; i++) {
            const prevIndex = (this.currentIndex - i + this.playlist.length) % this.playlist.length;
            if (prevIndex !== this.currentIndex)
                songsToCache.push(this.playlist[prevIndex]);
        }
        // Process caching for unique songs not already in cache
        const uniqueSongsToCache = [...new Map(songsToCache.map(item => [item.id, item])).values()];
        for (const song of uniqueSongsToCache) {
            if (!this.audioCache.has(song.id)) {
                try {
                    console.log(`Caching ${song.name}...`);
                    const response = await fetch(`${STREAM_URL_BASE}?fileId=${song.id}`);
                    const blob = await response.blob();
                    const blobUrl = URL.createObjectURL(blob);
                    this.audioCache.set(song.id, blobUrl, blob.size || 0);
                    console.log(`Cached ${song.name} successfully.`);
                }
                catch (error) {
                    console.warn(`Failed to cache ${song.name}:`, error);
                }
            }
        }
    }
    attachEventListeners() {
        UIElements.playPauseButton.addEventListener('click', () => this.togglePlayPause());
        UIElements.nextButton.addEventListener('click', () => this.playNext());
        UIElements.prevButton.addEventListener('click', () => this.playPrev());
        UIElements.audioPlayer.addEventListener('timeupdate', () => this.updateProgressBar());
        UIElements.audioPlayer.addEventListener('ended', () => this.playNext());
        UIElements.audioPlayer.addEventListener('play', () => {
            this.isPlaying = true;
            this.updatePlayPauseIcon();
            this.updateProgressBar();
        });
        UIElements.audioPlayer.addEventListener('pause', () => {
            this.isPlaying = false;
            this.updatePlayPauseIcon();
        });
        // Event listener for seeking
        UIElements.seekSlider.addEventListener('input', () => {
            UIElements.audioPlayer.currentTime = parseFloat(UIElements.seekSlider.value);
        });
        // Event listener for when audio metadata is loaded (to set duration)
        UIElements.audioPlayer.addEventListener('loadedmetadata', () => {
            if (!isNaN(UIElements.audioPlayer.duration) && (isFinite(UIElements.audioPlayer.duration))) {
                UIElements.seekSlider.max = UIElements.audioPlayer.duration.toString();
                UIElements.durationElement.textContent = this.formatTime(UIElements.audioPlayer.duration);
            }
            else {
                UIElements.seekSlider.max = "N/A:Streaming";
                UIElements.durationElement.textContent = "N/A:Streaming";
            }
        });
    }
}
// Start the application
new MusicPlayer();
//# sourceMappingURL=client.js.map