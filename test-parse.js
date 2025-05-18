import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';

// Get directory name in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Define the improved parseSongRequest function
function parseSongRequest(message) {
  // First, check for generic "sing a song" without specific info - this should return null
  const genericPattern = /^(?:can|could)\s+you\s+(?:sing|play)(?:\s+a|the)?\s+song\??$/i;
  if (genericPattern.test(message.trim())) {
    return null;
  }

  // Check if there's a YouTube URL in the message
  const youtubeUrlRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]+)(?:&\S*)?/;
  const youtubeMatch = message.match(youtubeUrlRegex);
  
  // Check if we should use the YouTube URL - but only if the message also contains song request keywords
  if (youtubeMatch && /\b(sing|cover|play.*song)\b/i.test(message)) {
    // Extract the video ID and construct the full URL
    const videoId = youtubeMatch[1];
    const fullUrl = `https://youtube.com/watch?v=${videoId}`;
    
    return { 
      songName: 'YouTube Song',
      youtubeUrl: fullUrl,
      videoId: videoId,
      query: fullUrl
    };
  }
  
  // Avoid confusing general statements about playing sounds/sound effects with song requests
  if (/\b(sound\s*effect|sfx)\b/i.test(message)) {
    return null;
  }
  
  // Check for artist-only requests (when user asks for any song by a specific artist)
  const artistOnlyPattern = /\b(?:can\s+you\s+)?(?:sing|play)(?:\s+a)?\s+(?:song|track)(?:\s+by|\s+from)\s+["']?([^"'?]+)["']?/i;
  const artistOnlyMatch = message.match(artistOnlyPattern);
  
  if (artistOnlyMatch) {
    const artist = artistOnlyMatch[1].trim();
    // If artist looks valid (not too short, not just "the", etc.)
    if (artist && artist.length > 2 && !['the', 'an', 'a'].includes(artist.toLowerCase())) {
      return {
        songName: `A song by ${artist}`,
        artist: artist,
        query: `popular song by ${artist}`
      };
    }
  }
  
  // Check for specific song requests
  const specificSongPattern = /\b(?:sing|cover|perform|play)\s+(?:the\s+song\s+)?["']?([^"']+)["']?(?:\s+by|\s+from)\s+["']?([^"'?]+)["']?/i;
  const specificSongMatch = message.match(specificSongPattern);
  
  if (specificSongMatch) {
    const songName = specificSongMatch[1].trim();
    const artist = specificSongMatch[2].trim();
    
    if (songName && artist) {
      return {
        songName,
        artist,
        query: `${songName} by ${artist}`
      };
    }
  }
  
  // More generic patterns as fallback
  const songPatterns = [
    /\b(sing|cover|perform)\s+(?:the\s+)?(?:song\s+)?["']?([^"']+)["']?/i,
    /\bplay\s+(?:the\s+)?song\s+["']?([^"']+)["']?/i
  ];
  
  for (const pattern of songPatterns) {
    const match = message.match(pattern);
    if (match) {
      // Extract the song name from the correct capture group
      const songName = match[2]?.trim();
      
      if (songName && songName.length > 1 && !['a', 'the', 'song'].includes(songName.toLowerCase())) {
        return { 
          songName, 
          query: songName 
        };
      }
    }
  }
  
  return null;
}

// Test the original problematic query
const testQuery1 = "Can you sing a song by Ado the japanese singer?";
console.log("\nTest 1 - Artist-only request:");
console.log(`Query: "${testQuery1}"`);
console.log("Result:", parseSongRequest(testQuery1));

// Test a specific song request
const testQuery2 = "Sing Fly Me To The Moon by Frank Sinatra";
console.log("\nTest 2 - Specific song request:");
console.log(`Query: "${testQuery2}"`);
console.log("Result:", parseSongRequest(testQuery2));

// Test a YouTube URL
const testQuery3 = "Please sing this song https://youtube.com/watch?v=dQw4w9WgXcQ";
console.log("\nTest 3 - YouTube URL request:");
console.log(`Query: "${testQuery3}"`);
console.log("Result:", parseSongRequest(testQuery3));

// Test what was failing before
const testQuery4 = "Can you sing a song?"; // This shouldn't return a song request
console.log("\nTest 4 - Generic request without artist (should return null):");
console.log(`Query: "${testQuery4}"`);
console.log("Result:", parseSongRequest(testQuery4)); 