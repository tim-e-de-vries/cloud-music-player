// File: src/app.ts
// This is the main TypeScript file for the frontend.

// --- Configuration ---
// IMPORTANT: Replace these with the URLs of your deployed Google Cloud Functions.
const GET_LIST_URL = 'https://us-central1-wireguard-283822.cloudfunctions.net/getMusicList';
const STREAM_URL_BASE = 'https://us-central1-wireguard-283822.cloudfunctions.net/streamMusicFile';

// --- Type Definitions ---
interface Song {
    id: string;
    name: string;
}

// --- DOM Elements ---
const UIElements = {
    loadingContainer: document.getElementById('loading-container')!,
    playerContainer: document.getElementById('player-container')!,
    errorContainer: document.getElementById('error-container')!,
    errorMessage: document.getElementById('error-message')!,
    audioPlayer: document.getElementById('audio-player') as HTMLAudioElement,
    playPauseButton: document.getElementById('play-pause-button')!,
    playIcon: document.getElementById('play-icon')!,
    pauseIcon: document.getElementById('pause-icon')!,
    prevButton: document.getElementById('prev-button')!,
    nextButton: document.getElementById('next-button')!,
    currentSongTitle: document.getElementById('current-song-title')!,
    playlistElement: document.getElementById('playlist')!,
    // New elements for seek slider
    seekSlider: document.getElementById('seekSlider') as HTMLInputElement,
    currentTimeElement: document.getElementById('currentTime')!,
    durationElement: document.getElementById('duration')!,
};

// --- Application State ---
class MusicPlayer {
    private playlist: Song[] = [];
    private currentIndex: number = -1;
    private isPlaying: boolean = false;
    private audioCache: Map<string, string> = new Map(); // <songId, blobUrl>

    constructor() {
        this.init();
    }

    private async init() {
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
        } catch (error) {
            console.error('Initialization failed:', error);
            this.showError('Could not load music library. Check the proxy URL and function logs.');
        }
    }
    
    private showPlayer() {
        UIElements.loadingContainer.classList.add('hidden');
        UIElements.playerContainer.classList.remove('hidden');
    }

    private showError(message: string) {
        UIElements.loadingContainer.classList.add('hidden');
        UIElements.playerContainer.classList.add('hidden');
        UIElements.errorMessage.textContent = message;
        UIElements.errorContainer.classList.remove('hidden');
    }

    private renderPlaylist() {
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

    private async playSong(index: number) {
        if (index < 0 || index >= this.playlist.length) {
            return;
        }

        this.currentIndex = index;
        const song = this.playlist[this.currentIndex];
        
        UIElements.currentSongTitle.textContent = song.name.replace(/\.(mp3|flac|wav)$/i, '');
        this.updatePlaylistUI();

        try {
            let songUrl: string;
            // Check cache first
            if (this.audioCache.has(song.id)) {
                songUrl = this.audioCache.get(song.id)!;
                console.log(`Playing ${song.name} from cache.`);
            } else {
                // Not in cache, use direct stream URL
                songUrl = `${STREAM_URL_BASE}?fileId=${song.id}`;
                console.log(`Streaming ${song.name} directly.`);
            }
            
            UIElements.audioPlayer.src = songUrl;
            await UIElements.audioPlayer.play();
            this.isPlaying = true;
            this.updatePlayPauseIcon();
            
            // Pre-cache surrounding songs
            this.updateCache();

        } catch (error) {
            console.error(`Error playing song ${song.name}:`, error);
            this.showError(`Could not play ${song.name}.`);
            this.isPlaying = false;
            this.updatePlayPauseIcon();
        }
    }
    
    private togglePlayPause() {
        if (this.currentIndex === -1 && this.playlist.length > 0) {
            // If no song has been played yet, start with the first one
            this.playSong(0);
        } else {
            if (this.isPlaying) {
                UIElements.audioPlayer.pause();
            } else {
                UIElements.audioPlayer.play();
            }
            this.isPlaying = !this.isPlaying;
            this.updatePlayPauseIcon();
        }
    }

    private playNext() {
        const nextIndex = (this.currentIndex + 1) % this.playlist.length;
        this.playSong(nextIndex);
    }

    private playPrev() {
        const prevIndex = (this.currentIndex - 1 + this.playlist.length) % this.playlist.length;
        this.playSong(prevIndex);
    }
    
    private updatePlayPauseIcon() {
        if (this.isPlaying) {
            UIElements.playIcon.classList.add('hidden');
            UIElements.pauseIcon.classList.remove('hidden');
        } else {
            UIElements.playIcon.classList.remove('hidden');
            UIElements.pauseIcon.classList.add('hidden');
        }
    }
    
    private updatePlaylistUI() {
        const items = UIElements.playlistElement.querySelectorAll('.song-item');
        items.forEach((item, index) => {
            if (index === this.currentIndex) {
                item.classList.add('active');
            } else {
                item.classList.remove('active');
            }
        });
    }

    private updateProgressBar() {
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
        if (!isNaN(duration) && (isFinite(duration)))  {
            UIElements.durationElement.textContent = this.formatTime(duration);
        }
        else {
            UIElements.durationElement.textContent = "N/A:Streaming";
        }
    }

    private formatTime(seconds: number): string {
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
    }

    /**
     * Caching logic: Fetches and caches the next 5 and previous 5 songs.
     */
    private async updateCache() {
        const cacheRange = 5;
        const songsToCache: Song[] = [];

        // Add next songs to cache queue
        for (let i = 1; i <= cacheRange; i++) {
            const nextIndex = (this.currentIndex + i) % this.playlist.length;
            if (nextIndex !== this.currentIndex) songsToCache.push(this.playlist[nextIndex]);
        }
        
        // Add previous songs to cache queue
        for (let i = 1; i <= cacheRange; i++) {
            const prevIndex = (this.currentIndex - i + this.playlist.length) % this.playlist.length;
            if (prevIndex !== this.currentIndex) songsToCache.push(this.playlist[prevIndex]);
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
                    this.audioCache.set(song.id, blobUrl);
                    console.log(`Cached ${song.name} successfully.`);
                } catch (error) {
                    console.warn(`Failed to cache ${song.name}:`, error);
                }
            }
        }
    }

    private attachEventListeners() {
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
            if (!isNaN(UIElements.audioPlayer.duration) && (isFinite(UIElements.audioPlayer.duration))   ) {
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