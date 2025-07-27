import difflib
import os
import requests
import functions_framework # Required for Google Cloud Functions
from ytmusicapi import YTMusic
from flask import jsonify # For returning JSON responses

# Initialize YTMusic globally or within the function if you need different configs
# For simplicity, we'll initialize globally.
# For authenticated access, you might pass headers_raw or cookie_file here
# For most public searches, unauthenticated is fine.
yt = YTMusic()

@functions_framework.http
def get_youtube_music_lyrics(request):
    """
    HTTP Cloud Function to search YouTube Music for a song and retrieve its lyrics.

    Args:
        request (flask.Request): The request object.
        <https://flask.palletsprojects.com/en/1.1.x/api/#incoming-request-data>

    Returns:
        A JSON response containing the song details and lyrics, or an error message.
        <https://flask.palletsprojects.com/en/1.1.x/api/#flask.json.jsonify>
    """

    request_json = request.get_json(silent=True)
    request_args = request.args

    artist = None
    track_title = None

    # Try to get parameters from JSON body first (POST requests)
    if request_json and 'artist' in request_json:
        artist = request_json['artist']
    if request_json and 'trackTitle' in request_json:
        track_title = request_json['trackTitle']

    # If not in JSON, try query parameters (GET requests)
    if not artist and request_args and 'artist' in request_args:
        artist = request_args['artist']
    if not track_title and request_args and 'trackTitle' in request_args:
        track_title = request_args['trackTitle']

    if not artist or not track_title:
        return jsonify({
            "error": "Missing 'artist' or 'trackTitle' parameters. "
                     "Please provide them in the request body (JSON) or query parameters."
        }), 400 # Bad Request

    search_string = f"{artist} {track_title}"
    result_data = {
        "artist": artist,
        "trackTitle": track_title,
        "lyrics": None,
        "artwork": None,
        "message": "Lyrics not found or an error occurred."
    }

    try:
        # Search for songs
        res = yt.search(query=search_string, filter='songs', limit=1)

        found_match = False
        for row in res:
            # Using difflib to confirm a good match
            if difflib.SequenceMatcher(None, track_title.lower(), row['title'].lower()).ratio() > 0.75:
                found_match = True
                playlist = yt.get_watch_playlist(row['videoId'])

                # Get artwork
                if 'tracks' in playlist and len(playlist['tracks']) > 0 and 'thumbnail' in playlist['tracks'][0]:
                    # Get the largest thumbnail available
                    thumbnails = playlist['tracks'][0]['thumbnail']
                    if thumbnails:
                        # Assuming the last one is often the largest
                        result_data['artwork'] = thumbnails[-1]['url']
                    
                # Get lyrics
                if "lyrics" in playlist and playlist["lyrics"] is not None:
                    try:
                        lyrics_info = yt.get_lyrics(playlist["lyrics"])
                        if 'lyrics' in lyrics_info:
                            result_data['lyrics'] = lyrics_info['lyrics']
                            result_data['message'] = "Lyrics found successfully."
                        else:
                            result_data['message'] = "Lyrics link found, but actual lyrics content was empty."
                    except Exception as e:
                        result_data['message'] = f"Error fetching lyrics content: {e}"
                else:
                    result_data['message'] = "No lyrics link available for this song on YouTube Music."
                break # Found a good match, stop searching

        if not found_match:
            result_data['message'] = "No close match found for the song on YouTube Music."

    except Exception as e:
        result_data['message'] = f"An unexpected error occurred during search or processing: {e}"
        # For server errors, return 500
        return jsonify(result_data), 500

    # Return 200 OK for successful processing, even if lyrics weren't found
    return jsonify(result_data), 200