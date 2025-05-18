import express from 'express';
import http from 'http';
import { Server as SocketIO } from 'socket.io';
import tmi from 'tmi.js';
import OpenAI from 'openai';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import msgpack from 'msgpack-lite';
import axios from 'axios';
import { createServer } from 'http';
import { MongoClient } from 'mongodb';
import { Session, WebSocketSession, TTSRequest } from 'fish-audio-sdk';
import soundPlay from 'sound-play';
import youtubeDl from 'youtube-dl-exec';
import ytSearch from 'yt-search';
import { v4 as uuidv4 } from 'uuid';

// Get directory name in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configure environment variables
dotenv.config();

// API Keys and Settings
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const FISHAUDIO_KEY = process.env.FISHAUDIO_KEY || "";
const VOICE_ID = process.env.VOICE_ID || "";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o";

// Song processing settings
const SONG_API_URL = process.env.SONG_API_URL || 'http://localhost:62362';
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const SONG_CACHE_DIR = path.join(__dirname, 'song-cache');
const VOICE_MODEL_ID = process.env.VOICE_MODEL_ID || 'Default Voice'; // The voice model ID to use for song conversion
const MAX_SONG_DOWNLOAD_TIME = parseInt(process.env.MAX_SONG_DOWNLOAD_TIME || '180000'); // 3 minutes
const SONG_PROGRESS_CHECK_INTERVAL = parseInt(process.env.SONG_PROGRESS_CHECK_INTERVAL || '2000'); // 2 seconds - faster check interval

// AI state tracking
const aiState = {
  isSpeaking: false,
  isProcessingSong: false,
  isSinging: false,
  lastSpoke: Date.now(),
  messageQueue: [],
  autoTalkEnabled: true,
  autoTalkInterval: 5 * 1000, // 5 seconds between autonomous messages
  autoTalkVariance: 2 * 1000, // 2 seconds variance
  songProcessingStartTime: 0,
  // New properties to track song state
  currentSongTitle: null,
  currentSongPath: null,
  processingTitle: null,
  processingProgress: 0,
  // New properties to track chat activity
  lastChatActivity: Date.now(),
  activeChatTimeout: 30 * 1000, // 30 seconds - don't autotalk if chat has been active in this timeframe
  // Add a new flag to track if the system is currently processing a queued message
  isProcessingQueue: false,
  // Add a property to track a pending song that's ready to play after speaking
  pendingSong: null,
  // Add a property to track stall message timers for cleanup
  stallMessageTimer: null
};

// Ensure directories exist
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(SONG_CACHE_DIR)) {
  fs.mkdirSync(SONG_CACHE_DIR, { recursive: true });
}

// Create audio-cache directory if it doesn't exist
const AUDIO_CACHE_DIR = path.join(__dirname, 'audio-cache');
if (!fs.existsSync(AUDIO_CACHE_DIR)) {
  fs.mkdirSync(AUDIO_CACHE_DIR, { recursive: true });
}

// Clean up old TTS files on startup
try {
  const files = fs.readdirSync(AUDIO_CACHE_DIR);
  for (const file of files) {
    if (file.startsWith('tts_') && file.endsWith('.mp3')) {
      fs.unlinkSync(path.join(AUDIO_CACHE_DIR, file));
    }
  }
  console.log('Cleaned up old TTS files');
} catch (error) {
  console.error('Error cleaning up old TTS files:', error);
}

// Initialize Express App and Server
const app = express();
const server = http.createServer(app);
const io = new SocketIO(server);

// OpenAI Client
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  baseURL: OPENAI_BASE_URL
});

// Subtitle data
let currentSubtitle = "";

// Fish Audio TTS instance - change from const to let
let tts;

// Sound effects directory and available sounds
const SOUND_EFFECTS_DIR = path.join(__dirname, 'sound-effects');
let availableSounds = {};

// Function to scan and load available sound effects
function loadAvailableSounds() {
  try {
    if (!fs.existsSync(SOUND_EFFECTS_DIR)) {
      fs.mkdirSync(SOUND_EFFECTS_DIR, { recursive: true });
      console.log('Created sound-effects directory');
      return;
    }
    
    const files = fs.readdirSync(SOUND_EFFECTS_DIR);
    files.forEach(file => {
      if (file.endsWith('.mp3')) {
        const soundName = path.basename(file, '.mp3');
        const soundPath = path.join(SOUND_EFFECTS_DIR, file);
        availableSounds[soundName] = soundPath;
      }
    });
    
    console.log(`Loaded ${Object.keys(availableSounds).length} sound effects:`, Object.keys(availableSounds));
  } catch (error) {
    console.error('Error loading sound effects:', error);
  }
}

// Load sound effects on startup
loadAvailableSounds();

// Watch sound-effects directory for changes
try {
  fs.watch(SOUND_EFFECTS_DIR, { persistent: true }, (eventType, filename) => {
    if (filename && filename.endsWith('.mp3')) {
      console.log(`Sound effect file changed: ${filename}, event: ${eventType}`);
      
      // Reload all available sounds
      loadAvailableSounds();
      
      // Notify connected clients about sound list update
      io.emit('sound-effects-updated', {
        sounds: Object.keys(availableSounds)
      });
    }
  });
  console.log('Watching sound-effects directory for changes');
} catch (error) {
  console.error('Error setting up file watcher for sound effects:', error);
}

// Function to play a sound effect
async function playSoundEffect(soundName, times = 1) {
  if (!availableSounds[soundName]) {
    console.error(`Sound effect "${soundName}" not found`);
    return false;
  }
  
  const soundPath = availableSounds[soundName];
  console.log(`Playing sound effect: ${soundName} (${times} times)`);
  
  // Limit maximum repetitions for safety
  const repeatTimes = Math.min(parseInt(times) || 1, 10);
  
  try {
    // Play sound through system speakers
    for (let i = 0; i < repeatTimes; i++) {
      // For multiple plays, play sequentially
      if (i > 0) {
        // Wait for previous sound to finish approximately
        // Get audio duration or use a default estimate
        const waitTime = 1500; // Default 1.5 seconds wait
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
      
      // Play the sound
      await soundPlay.play(soundPath);
      
      // Also notify clients over WebSocket so browser can play it too
      io.emit('play-sound-effect', {
        soundName: soundName,
        timestamp: Date.now()
      });
    }
    
    return true;
  } catch (error) {
    console.error(`Error playing sound effect "${soundName}":`, error);
    return false;
  }
}

// Search YouTube for a song
async function searchYouTube(query) {
  try {
    console.log(`Searching YouTube for: "${query}"`);
    const results = await ytSearch(query);
    
    // Get the top video result
    const video = results.videos.length > 0 ? results.videos[0] : null;
    
    if (!video) {
      console.error('No videos found for query:', query);
      return null;
    }
    
    console.log(`Found video: "${video.title}" (${video.url})`);
    return video;
  } catch (error) {
    console.error('Error searching YouTube:', error);
    return null;
  }
}

// Download a YouTube video as MP3
async function downloadYouTubeAudio(videoUrl, songName) {
  try {
    console.log(`Downloading audio from: ${videoUrl}`);
    
    // Generate safe filename based on song name
    const safeFilename = songName
      .replace(/[^\w\s-]/g, '') // Remove special characters
      .replace(/\s+/g, '-')     // Replace spaces with hyphens
      .toLowerCase();
    
    const timestamp = Date.now();
    const filename = `${safeFilename}-${timestamp}.webm`; // Use webm as initial format
    const outputPath = path.join(DOWNLOADS_DIR, filename);
    
    console.log(`Output path: ${outputPath}`);
    
    try {
      // All YouTube URLs should be treated as direct links
      const isDirectYoutubeLink = true;
      
      if (isDirectYoutubeLink) {
        console.log('Using direct youtube-dl download for specific video URL');
        
        // For direct links, use the URL as is with minimal options to ensure we get the exact video
        await youtubeDl(videoUrl, {
          output: outputPath,
          noCheckCertificate: true,
          format: 'bestaudio',
          noWarnings: true
        });
      } else {
        // For search queries, use the previous approach
        console.log('Using standard download approach');
        
        await youtubeDl(videoUrl, {
          output: outputPath,
          noCheckCertificate: true,
          preferFreeFormats: true,
          format: 'bestaudio', // Get best audio quality
          quiet: false
        });
      }
      
      // Check if file exists and has content
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        console.log(`Download successful: ${outputPath}, size: ${fs.statSync(outputPath).size} bytes`);
        return outputPath;
      } else {
        // Check if a different file was created (yt-dlp might have renamed it)
        const files = fs.readdirSync(DOWNLOADS_DIR);
        const downloadedFile = files.find(file => file.includes(`${timestamp}`) || file.includes(safeFilename));
        
        if (downloadedFile) {
          const actualPath = path.join(DOWNLOADS_DIR, downloadedFile);
          console.log(`Found downloaded file with different name: ${actualPath}`);
          return actualPath;
        }
        
        throw new Error('Downloaded file not found or is empty');
      }
    } catch (dlError) {
      console.error('Download error:', dlError);
      
      // One more attempt with absolute minimal options
      console.log('Trying final fallback method...');
      const finalOutputPath = path.join(DOWNLOADS_DIR, `final-${timestamp}.webm`);
      
      await youtubeDl.exec(videoUrl, {
        output: finalOutputPath,
        format: 'bestaudio',
        noCheckCertificate: true,
        noWarnings: true
      });
      
      if (fs.existsSync(finalOutputPath) && fs.statSync(finalOutputPath).size > 0) {
        console.log(`Final fallback successful: ${finalOutputPath}`);
        return finalOutputPath;
      } else {
        // Look for any file created in the last minute
        const files = fs.readdirSync(DOWNLOADS_DIR);
        const recentFile = files
          .map(file => ({ name: file, path: path.join(DOWNLOADS_DIR, file), time: fs.statSync(path.join(DOWNLOADS_DIR, file)).mtimeMs }))
          .filter(file => Date.now() - file.time < 60000) // Last minute
          .sort((a, b) => b.time - a.time)[0]; // Most recent
        
        if (recentFile) {
          console.log(`Found recent download: ${recentFile.path}`);
          return recentFile.path;
        }
        
        throw new Error('All download methods failed');
      }
    }
  } catch (error) {
    console.error('Error downloading YouTube audio:', error);
    throw error;
  }
}

// Function to process a song download and conversion request
async function processSongRequest(songRequest, username) {
  try {
    // Check if a song is already playing or processing - don't allow two songs at once
    if (aiState.isProcessingSong || aiState.isSinging) {
      console.log('Attempted to process a song while another is already playing/processing');
      const errorMessage = `Cannot play a new song while ${aiState.isProcessingSong ? 'processing' : 'singing'} another song. Please wait until the current song is finished.`;
      updateSubtitle(`Song request rejected`);
      // Generate a more natural AI response for this scenario
      await generateAIResponse(`Whoa there, ${username}! I'm still in the middle of ${aiState.isProcessingSong ? `getting "${aiState.processingTitle || 'a song'}" ready` : 'singing right now'}. One at a time, please! Let's finish this one first.`, "System");
      return {
        success: false,
        error: errorMessage
      };
    }

    const songNameFromRequest = typeof songRequest === 'object' ? 
      (songRequest.songName || songRequest.query || 'Unknown Song') : 
      songRequest;
    
    // Get transpose value if provided
    const transposeValue = songRequest.transposeValue !== undefined ? songRequest.transposeValue : null;
    
    if (transposeValue !== null) {
      console.log(`Using requested transpose value: ${transposeValue} semitones`);
    }

    // Set the AI state to processing song
    aiState.isProcessingSong = true;
    aiState.songProcessingStartTime = Date.now();
    aiState.processingTitle = songNameFromRequest; // Save title to state
    aiState.processingProgress = 0; // Reset progress

    // Make sure directories exist
    [DOWNLOADS_DIR, SONG_CACHE_DIR].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
    
    // AI's initial enthusiastic response about starting the song process
    // This happens BEFORE any lengthy download or API calls
    const initialEnthusiasmMessages = [
        `Alright, ${username}, you want me to sing "${songNameFromRequest}"? I can give it a shot! Let me see if I can find it...`,
        `"${songNameFromRequest}", huh? Sounds interesting, ${username}! Let me get everything ready. This might take a moment!`,
        `A song request from ${username}! You're asking for "${songNameFromRequest}"? Okay, okay, I'll prepare it. Hope it turns out good!`
    ];
    const enthusiasmMessage = initialEnthusiasmMessages[Math.floor(Math.random() * initialEnthusiasmMessages.length)];
    await generateAIResponse(enthusiasmMessage, "System"); // Using "System" so it doesn't add "System says:"

    // Notify clients we're starting the process (this can still happen)
    io.emit('song-update', {
      title: songNameFromRequest,
      status: `Searching for "${songNameFromRequest}"...`,
      progress: 0
    });
    
    updateSubtitle(`Preparing to sing "${songNameFromRequest}"...`);
    console.log(`Processing song request "${songNameFromRequest}" from ${username}`);

    // Removed stall message from here, will be handled by monitorSongProgress or prompt.

    let video;
    if (songRequest.youtubeUrl && songRequest.directYouTubeLink) {
      console.log(`Using direct YouTube URL: ${songRequest.youtubeUrl}`);
      video = {
        title: songRequest.songName || `YouTube video (ID: ${songRequest.videoId || 'N/A'})`,
        url: songRequest.youtubeUrl,
        videoId: songRequest.videoId,
        directUrl: true
      };
      if (songRequest.useVideoTitle && video.videoId) {
        try {
          const videoInfo = await youtubeDl(songRequest.youtubeUrl, { skipDownload: true, dumpJson: true, noWarnings: true, noCallHome: true });
          video.title = videoInfo.title || video.title;
        } catch (infoError) { console.error('Error fetching video info:', infoError); }
      }
      io.emit('song-update', { title: video.title, status: `Downloading "${video.title}"...`, progress: 10 });
    } else {
      const searchQuery = typeof songRequest === 'object' && songRequest.query ? songRequest.query : songNameFromRequest;
      video = await searchYouTube(searchQuery);
      if (!video) {
        const errorMessage = `I couldn't find "${searchQuery}" on YouTube, ${username}. Maybe try a different song or check the spelling?`;
        await generateAIResponse(errorMessage, "System");
        updateSubtitle(`Song not found: ${searchQuery}`);
        io.emit('song-update', { title: songNameFromRequest, status: `Couldn't find "${searchQuery}"`, progress: 0, error: true });
        aiState.isProcessingSong = false;
        setTimeout(processNextInQueue, 1000);
        return { success: false, error: `Couldn't find "${searchQuery}" on YouTube.` };
      }
      io.emit('song-update', { title: video.title, status: `Found "${video.title}". Downloading...`, progress: 10 });
    }
    
    // The actual song title to be used from here on is video.title
    const actualSongTitle = video.title;
    aiState.processingTitle = actualSongTitle; // Update state with the found title

    updateSubtitle(`Downloading "${actualSongTitle}"...`);
    let audioPath;
    try {
      audioPath = await downloadYouTubeAudio(video.url, actualSongTitle); // Use actualSongTitle for filename
      if (!fs.existsSync(audioPath) || fs.statSync(audioPath).size === 0) throw new Error('Downloaded file is empty or does not exist');
    } catch (downloadError) {
      console.error('Error downloading audio:', downloadError);
      const errorMessage = `I had trouble downloading "${actualSongTitle}", ${username}. The download failed. Maybe the video is unavailable?`;
      await generateAIResponse(errorMessage, "System");
      updateSubtitle(`Download failed: ${actualSongTitle}`);
      io.emit('song-update', { title: actualSongTitle, status: `Failed to download: ${downloadError.message}`, progress: 0, error: true });
      aiState.isProcessingSong = false;
      setTimeout(processNextInQueue, 1000);
      return { success: false, error: `Failed to download "${actualSongTitle}": ${downloadError.message}` };
    }

    updateSubtitle(`Processing "${actualSongTitle}" with AI voice...`);
    io.emit('song-update', { title: actualSongTitle, status: `Processing "${actualSongTitle}" with AI voice...`, progress: 30 });
    
    const conversionResult = await createSongConversion(audioPath, actualSongTitle, transposeValue); // Pass actualSongTitle

    if (!conversionResult.success) {
      const errorMessage = `I ran into an issue trying to prepare "${actualSongTitle}" for singing, ${username}. ${conversionResult.error || 'The conversion process failed.'}`;
      await generateAIResponse(errorMessage, "System");
      updateSubtitle(`Conversion failed: ${actualSongTitle}`);
      io.emit('song-update', { title: actualSongTitle, status: errorMessage, progress: 0, error: true });
      if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
      aiState.isProcessingSong = false;
      setTimeout(processNextInQueue, 1000);
      return { success: false, error: conversionResult.error || 'Failed to process song' };
    }
    
    updateSubtitle(`Starting conversion of "${actualSongTitle}"...`);
    io.emit('song-update', { title: actualSongTitle, status: `Starting conversion...`, progress: 40 });

    if (conversionResult.type === 'direct-play' && conversionResult.filePath) {
      // ... (direct play logic, ensure actualSongTitle is used for AI messages)
      // For brevity, I'll assume this part uses actualSongTitle correctly if it generates AI messages
      // If not, it should be updated similarly.
      console.log(`Direct playback for "${actualSongTitle}"`);
        const readyText = `API unavailable. Playing original audio for "${actualSongTitle}"`;
        updateSubtitle(`Playing original: "${actualSongTitle}"`);
        io.emit('song-update', { title: actualSongTitle, status: readyText, progress: 100 });
        const webPath = `/song-cache/${path.basename(conversionResult.filePath)}`;
        aiState.currentSongTitle = actualSongTitle;
        aiState.currentSongPath = webPath;
        io.emit('play-converted-song', { path: webPath, title: actualSongTitle, direct: true });
        aiState.isProcessingSong = false; // Done processing
        aiState.isSinging = true; // Now singing
        await soundPlay.play(conversionResult.filePath);
        const finishedText = `Finished playing the original for "${actualSongTitle}" since the conversion API wasn't available.`;
        await generateAIResponse(finishedText, "System"); // AI comment
        updateSubtitle(`Finished: "${actualSongTitle}" (Original)`);
        io.emit('song-update', { title: actualSongTitle, status: finishedText, progress: 100, finished: true });
        io.emit('song-finished', { title: actualSongTitle });
        aiState.isSinging = false;
        setTimeout(processNextInQueue, 1000);
        return { success: true, jobId: conversionResult.jobId, videoTitle: actualSongTitle, directPlay: true };
    }
    
    // Pass actualSongTitle to monitorSongProgress
    monitorSongProgress(conversionResult.jobId, username, actualSongTitle); 
    
    // The AI has already expressed enthusiasm.
    // Further chit-chat during processing will be handled by monitorSongProgress.

    return {
      success: true,
      jobId: conversionResult.jobId,
      videoTitle: actualSongTitle // Return the title that was actually processed
    };
  } catch (error) {
    console.error('Error in processSongRequest:', error);
    const songName = typeof songRequest === 'object' ? (songRequest.songName || songRequest.query || 'that song') : songRequest;
    const errorMessage = `Oh dear, something went really wrong while I was trying to get "${songName}" ready, ${username}. I'm not sure what happened.`;
    await generateAIResponse(errorMessage, "System");
    updateSubtitle(`Error processing song: ${songName}`);
    io.emit('song-update', { title: songName, status: `Error: ${error.message}`, progress: 0, error: true });
    aiState.isProcessingSong = false;
    setTimeout(processNextInQueue, 1000);
    return { success: false, error: `Error processing song: ${error.message}` };
  }
}

// Function to create a song conversion job
async function createSongConversion(audioFilePath, songTitle, transposeValue) {
  try {
    console.log(`Creating song conversion for: ${audioFilePath}`);
    
    // Ensure directory exists
    if (!fs.existsSync(SONG_CACHE_DIR)) {
      fs.mkdirSync(SONG_CACHE_DIR, { recursive: true });
    }
    
    // Get absolute paths for the local directories
    const appDir = path.resolve(__dirname);
    const modelsPath = path.join(appDir, 'models');
    const outputDirectory = path.join(appDir, 'outputs');
    const weightsPath = path.join(appDir, 'weights');
    
    // Ensure these directories exist
    [modelsPath, outputDirectory, weightsPath].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
    
    // Use provided transpose value if available
    let finalTransposeValue = 0;
    
    if (transposeValue !== null && transposeValue !== undefined) {
      // Manual transpose value provided, use it directly
      finalTransposeValue = transposeValue;
      console.log(`Using manually specified transpose value: ${finalTransposeValue} semitones`);
    } else {
      // If no transposeValue is provided, default to 0
      console.log('No transpose value provided by user, defaulting to 0 semitones.');
      finalTransposeValue = 0;
    }
    
    console.log(`Using transpose value: ${finalTransposeValue} semitones`);
    
    const payload = {
      songUrlOrFilePath: audioFilePath,
      modelData: [
        {
          modelId: VOICE_MODEL_ID,
          weight: 1
        }
      ],
      options: {
        pitch: finalTransposeValue, // Apply the determined transposition
        preStemmed: false,
        vocalsOnly: false,
        sampleMode: false,
        deEchoDeReverb: true,
        f0Method: "rmvpe",
        torchCompile: "none",
        device: "cuda",  // Change to "cpu" if no GPU is available
        stemmingMethod: "UVR-MDX-NET Voc FT",
        indexRatio: 0.75,
        consonantProtection: 0.35,
        outputFormat: "mp3_320k",
        volumeEnvelope: 1,
        acceptWebmFormat: true // Add support for webm format
      },
      modelsPath: modelsPath,
      outputDirectory: outputDirectory,
      weightsPath: weightsPath
    };
    
    // Log the API request for debugging
    console.log(`Sending request to ${SONG_API_URL}/create_song with payload:`, JSON.stringify(payload, null, 2));
    
    // Check if API is responding before sending full request
    try {
      await axios.get(SONG_API_URL);
    } catch (apiCheckError) {
      console.error('Song conversion API is not available:', apiCheckError.message);
      
      // Fallback - play the downloaded audio directly if API is unavailable
      if (fs.existsSync(audioFilePath) && fs.statSync(audioFilePath).size > 0) {
        console.log(`Song conversion API unavailable. Playing downloaded audio directly: ${audioFilePath}`);
        
        // Copy the file to our cache
        const destFilename = `direct-${path.basename(audioFilePath)}`;
        const destPath = path.join(SONG_CACHE_DIR, destFilename);
        
        // Copy the output file to our cache
        fs.copyFileSync(audioFilePath, destPath);
        
        // Return a special response that indicates we should play it directly
        return {
          success: true,
          jobId: `direct-${Date.now()}`,
          type: 'direct-play',
          filePath: destPath
        };
      }
      
      return {
        success: false,
        error: `Song conversion API is not responding: ${apiCheckError.message}`
      };
    }
    
    const response = await axios.post(`${SONG_API_URL}/create_song`, payload);
    
    console.log('Song conversion job created:', response.data);
    
    if (response.data && response.data.jobId) {
      return {
        success: true,
        jobId: response.data.jobId,
        type: response.data.type
      };
    } else {
      return {
        success: false,
        error: 'No job ID received from API'
      };
    }
  } catch (error) {
    console.error('Error creating song conversion:', error);
    return {
      success: false,
      error: `API Error: ${error.message}`
    };
  }
}

// Function to check song conversion progress
async function checkSongProgress(jobId) {
  try {
    // Corrected: Use POST request with a JSON body
    const response = await axios.post(`${SONG_API_URL}/song_progress`, { jobId });
    if (response.data.error) {
      console.error('Error checking song progress:', response.data.error);
      // Removed AI response from here, it will be handled in monitorSongProgress
      return { error: response.data.error, status: 'failed' }; // Ensure status is failed
    }
    return response.data;
  } catch (error) {
    console.error('Error checking song progress:', error);
    // Removed AI response from here, it will be handled in monitorSongProgress
    return { error: error.message, status: 'failed' }; // Ensure status is failed
  }
}

// Function to monitor and report song conversion progress
async function monitorSongProgress(jobId, username, songTitle) {
  console.log(`Starting to monitor song progress for job ${jobId} ("${songTitle}")`);
  let lastProgress = 0;
  let updatesSent = 0;
  let failureNotified = false;
  let playbackStarted = false;
  let songReady = false;
  
  // Start sending hype messages right when monitoring starts
  // Generate initial hype message immediately with a small random delay
  setTimeout(async () => {
    // Only send initial message if song isn't already ready
    if (!songReady && !playbackStarted && aiState.isProcessingSong) {
      // Initial message when song starts processing
      const initialMessages = [
        `I'm starting to work on that "${songTitle}" song. It'll take a minute to get everything just right!`,
        `So you want to hear "${songTitle}"? I'm working on it now. The conversion takes a bit of time...`,
        `Getting "${songTitle}" ready for you. This might take a little while, but it should be worth it!`
      ];
      const initialMessage = initialMessages[Math.floor(Math.random() * initialMessages.length)];
      await generateAIResponse(initialMessage, "System", true);
      
      // Schedule the first actual stall message after a short delay
      // Store the timer ID for possible cleanup later
      if (aiState.stallMessageTimer) {
        clearTimeout(aiState.stallMessageTimer);
      }
      aiState.stallMessageTimer = setTimeout(() => generateStallMessage(songTitle), 10000);
    }
  }, Math.floor(Math.random() * 2000) + 1000); // Random delay between 1-3 seconds

  const updateProgress = async () => {
    if (failureNotified || playbackStarted) return; // Stop if already failed or played

    try {
      const progressResult = await checkSongProgress(jobId);

      if (progressResult.error || progressResult.status === 'failed') {
        if (!failureNotified) {
          console.error(`Song processing failed or error for job ${jobId}:`, progressResult.error || 'Unknown failure');
          const failureMessage = `Oh no... I couldn't finish singing "${songTitle}". Something went wrong. Maybe we can try another song?`;
          await generateAIResponse(failureMessage, username);
          failureNotified = true;
          aiState.isProcessingSong = false;
          aiState.processingTitle = null;
          aiState.processingProgress = 0;
          // Clear any pending stall messages
          if (aiState.stallMessageTimer) {
            clearTimeout(aiState.stallMessageTimer);
            aiState.stallMessageTimer = null;
          }
          setTimeout(processNextInQueue, 1000); // Process queue after failure
        }
        return;
      }

      const currentProgress = progressResult.percent || 0;
      aiState.processingProgress = currentProgress;

      // Update clients on progress
      io.emit('song-update', {
        title: songTitle,
        status: progressResult.message || `Processing "${songTitle}" - ${currentProgress}%`,
        progress: currentProgress
      });

      // AI chit-chat during processing - this is now handled by generateStallMessage
      // but we'll keep these progress update messages when significant progress happens
      if (currentProgress > lastProgress + 20 && currentProgress < 100 && updatesSent < 2) { // Limit updates
        const updates = [
          `Still working on "${songTitle}"... It's about ${currentProgress}% done! Getting there.`,
          `Making good progress on "${songTitle}"! Currently at ${currentProgress}%. Hope you're looking forward to it!`
        ];
        const update = updates[Math.floor(Math.random() * updates.length)];
        await generateAIResponse(update, username);
        lastProgress = currentProgress;
        updatesSent++;
      }

      if (progressResult.status === 'completed' && progressResult.outputFilepath) {
        if (playbackStarted) return; // Already handled
        
        // Mark that the song is ready, but don't start playback immediately
        songReady = true;
        console.log(`Song "${songTitle}" (Job ID: ${jobId}) is ready for playback`);
        
        // Clear any pending stall message timers when song is ready
        if (aiState.stallMessageTimer) {
          console.log(`Clearing pending stall message timer for "${songTitle}" as song is ready`);
          clearTimeout(aiState.stallMessageTimer);
          aiState.stallMessageTimer = null;
        }
        
        // Check if we can start playing or need to wait
        if (!aiState.isSpeaking) {
          await startSongPlayback(progressResult, songTitle, username);
          playbackStarted = true;
        } else {
          console.log(`❗ AI is currently speaking. Will play song "${songTitle}" after speech completes.`);
          // We'll start playback when speaking ends - handled in the generateAIResponse finally block
          aiState.pendingSong = {
            result: progressResult,
            title: songTitle,
            username: username
          };
        }
        return;
      }

      // Continue monitoring if not completed and no failure
      if (!failureNotified && !playbackStarted && !songReady) {
        setTimeout(updateProgress, SONG_PROGRESS_CHECK_INTERVAL);
      }

    } catch (error) {
      console.error(`Error in monitorSongProgress for job ${jobId}:`, error);
      if (!failureNotified) {
        const errorMessage = `I'm having a bit of trouble with the song "${songTitle}"... My systems are acting up. Maybe try again in a bit?`;
        await generateAIResponse(errorMessage, username);
        failureNotified = true;
      }
      aiState.isProcessingSong = false;
      aiState.processingTitle = null;
      aiState.processingProgress = 0;
      // Clear any pending stall messages on error
      if (aiState.stallMessageTimer) {
        clearTimeout(aiState.stallMessageTimer);
        aiState.stallMessageTimer = null;
      }
      setTimeout(processNextInQueue, 1000); // Process queue after error
    }
  };

  updateProgress(); // Start the first check
}

// New helper function to handle song playback once ready
async function startSongPlayback(progressResult, songTitle, username) {
  try {
    // Clear any pending stall message timer when starting playback
    if (aiState.stallMessageTimer) {
      console.log(`Clearing stall message timer as "${songTitle}" is now playing`);
      clearTimeout(aiState.stallMessageTimer);
      aiState.stallMessageTimer = null;
    }
    
    // Set isSinging state before any async operations
    aiState.isProcessingSong = false;
    aiState.isSinging = true;
    
    const sourcePath = progressResult.outputFilepath;
    if (!fs.existsSync(sourcePath)) {
      console.error(`Output file not found: ${sourcePath}`);
      const errorMsg = `I thought "${songTitle}" was ready, but I can't find the file... How strange.`;
      await generateAIResponse(errorMsg, username);
      aiState.isSinging = false; // Reset singing state
      aiState.processingTitle = null;
      aiState.processingProgress = 0;
      setTimeout(processNextInQueue, 1000);
      return;
    }

    const destFilename = `${progressResult.jobId}-final.mp3`;
    const destPath = path.join(SONG_CACHE_DIR, destFilename);
    fs.copyFileSync(sourcePath, destPath);
    console.log(`Copied "${songTitle}" to cache: ${destPath}`);

    const webPath = `/song-cache/${destFilename}`;
    aiState.currentSongTitle = songTitle;
    aiState.currentSongPath = webPath;

    io.emit('play-converted-song', {
      path: webPath,
      title: songTitle
    });
    
    updateSubtitle(`Now playing: "${songTitle}"`);

    // AI announces it's about to play (this is the pre-play chit-chat)
    const prePlayMessage = `Alright, "${songTitle}" is ready! Here it goes... let me know what you think!`;
    await generateAIResponse(prePlayMessage, username);

    await soundPlay.play(destPath);
    console.log(`Finished playing "${songTitle}" via soundPlay.`);

    // AI comments after finishing
    const postPlayMessages = [
      `That was "${songTitle}"! How was it? I get a bit nervous performing, hehe.`,
      `Phew, all done with "${songTitle}"! Hope you enjoyed it! What should I sing next time?`,
      `And that's "${songTitle}"! Did it sound alright? I practiced a bit!`
    ];
    const postPlayMessage = postPlayMessages[Math.floor(Math.random() * postPlayMessages.length)];
    await generateAIResponse(postPlayMessage, username);

    // Clear all song-related states
    aiState.isSinging = false; // No longer singing
    aiState.isProcessingSong = false; // No longer processing
    aiState.currentSongTitle = null;
    aiState.currentSongPath = null;
    aiState.processingTitle = null;
    aiState.processingProgress = 0;
    
    io.emit('song-finished', { title: songTitle });
    setTimeout(processNextInQueue, 1000); // Process queue after song
  } catch (error) {
    console.error(`Error in startSongPlayback for "${songTitle}":`, error);
    aiState.isSinging = false; // No longer singing
    aiState.isProcessingSong = false; // No longer processing
    aiState.processingTitle = null;
    aiState.processingProgress = 0;
    setTimeout(processNextInQueue, 1000);
  }
}

// Function to parse response for sound effect commands
function parseResponseForSoundEffects(text) {
  // Original text without sound commands
  let cleanText = text;
  
  // Sound commands to execute
  const soundCommands = [];
  
  // Match @sound(name, times) pattern
  // This regex captures the sound name and optional times parameter
  const soundRegex = /@sound\s*\(\s*["']([^"']+)["']\s*(?:,\s*["']?(\d+)["']?)?\s*\)/g;
  
  let match;
  while ((match = soundRegex.exec(text)) !== null) {
    const [fullMatch, soundName, times = "1"] = match;
    soundCommands.push({ soundName, times });
    
    // Remove the command from clean text
    cleanText = cleanText.replace(fullMatch, '');
  }
  
  // Match @sing(song, artist) pattern for song requests
  const singRegex = /@sing\s*\(\s*["']([^"']+)["']\s*(?:,\s*["']?([^"']+)["']?)?\s*\)/g;
  
  // Song commands to execute
  const songCommands = [];
  
  while ((match = singRegex.exec(text)) !== null) {
    const [fullMatch, songName, artist = ""] = match;
    songCommands.push({ songName, artist });
    
    // Remove the command from clean text
    cleanText = cleanText.replace(fullMatch, '');
  }
  
  // Clean up any excess spaces from removal
  cleanText = cleanText.replace(/\s+/g, ' ').trim();
  
  return { cleanText, soundCommands, songCommands };
}

// Function to parse and detect song requests in user messages
function parseSongRequest(message) {
  // First, check for generic "sing a song" without specific info - this should return null
  const genericPattern = /^(?:can|could)\s+you\s+(?:sing|play)(?:\s+a|the)?\s+song\??$/i;
  if (genericPattern.test(message.trim())) {
    return null;
  }

  // Check for manual transpose command in the message
  let transposeValue = null;
  const transposePattern = /transpose[:\s]+([+-]?\d+)/i;
  const transposeMatch = message.match(transposePattern);
  if (transposeMatch) {
    transposeValue = parseInt(transposeMatch[1], 10);
    console.log(`Manual transpose value detected: ${transposeValue} semitones`);
    
    // Limit to reasonable range (-12 to +12 semitones)
    transposeValue = Math.max(-12, Math.min(12, transposeValue));
  }

  // Define YouTube URL regex pattern once to be reused
  const youtubeUrlRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/|music\.youtube\.com\/(?:watch\?v=))([a-zA-Z0-9_-]+)(?:&\S*)?/;

  // Check if the message is just a YouTube URL
  const trimmedMessage = message.trim();
  if (youtubeUrlRegex.test(trimmedMessage) && 
      trimmedMessage.replace(youtubeUrlRegex, '').trim().length < 5) { // Almost the whole message is a URL
    
    const youtubeMatch = trimmedMessage.match(youtubeUrlRegex);
    const videoId = youtubeMatch[1];
    const fullUrl = youtubeMatch[0].startsWith('http') ? youtubeMatch[0] : `https://${youtubeMatch[0]}`;
    
    console.log(`Message is just a YouTube URL: ${fullUrl}`);
    
    return {
      songName: 'YouTube Video',
      youtubeUrl: fullUrl,
      videoId: videoId,
      directYouTubeLink: true,
      query: fullUrl, // This will be ignored for direct URLs
      useVideoTitle: true,
      transposeValue: transposeValue // Add the transpose value if specified
    };
  }
  
  // Special case for "sing this song [URL]" pattern - detect and prioritize this first
  const singThisSongUrlPattern = /(?:sing|play)\s+(?:this|that|the)\s+song\s+(https?:\/\/\S+)/i;
  const singThisSongMatch = message.match(singThisSongUrlPattern);
  
  if (singThisSongMatch) {
    const potentialUrl = singThisSongMatch[1];
    
    // Check if it's a YouTube URL
    const youtubeMatch = potentialUrl.match(youtubeUrlRegex);
    
    if (youtubeMatch) {
      // Extract the video ID
      const videoId = youtubeMatch[1];
      // Get just the URL part without extra query parameters if needed
      const cleanUrl = youtubeMatch[0];
      // Ensure it has https:// prefix
      const fullUrl = cleanUrl.startsWith('http') ? cleanUrl : `https://${cleanUrl}`;
      
      console.log(`"Sing this song URL" pattern detected with YouTube URL: ${fullUrl}`);
      
      return {
        songName: 'YouTube Video',
        youtubeUrl: fullUrl,
        videoId: videoId,
        directYouTubeLink: true,
        query: fullUrl, // This will be ignored for direct URLs
        useVideoTitle: true,
        transposeValue: transposeValue // Add the transpose value if specified
      };
    }
  }

  // Check if there's a YouTube URL in the message
  const youtubeMatch = message.match(youtubeUrlRegex);
  
  // First priority: If there's a YouTube URL, use it directly regardless of other keywords
  if (youtubeMatch) {
    // Extract the video ID and construct the full URL
    const videoId = youtubeMatch[1];
    
    // Get the original URL from the message instead of creating a new one
    const originalUrl = message.substring(youtubeMatch.index, youtubeMatch.index + youtubeMatch[0].length);
    // Ensure it has https:// prefix
    const fullUrl = originalUrl.startsWith('http') ? originalUrl : `https://${originalUrl}`;
    
    console.log(`YouTube URL detected in message. Direct URL: ${fullUrl}`);
    
    // Don't try to extract song titles - this causes issues with URLs containing song names
    return { 
      songName: 'YouTube Video',
      youtubeUrl: fullUrl,
      videoId: videoId,
      directYouTubeLink: true, // Flag to indicate this is a direct link
      query: fullUrl, // This will be ignored for direct URLs
      useVideoTitle: true,
      transposeValue: transposeValue // Add the transpose value if specified
    };
  }
  
  // Rest of the function remains the same...
  
  // Avoid confusing general statements about playing sounds/sound effects with song requests
  if (/\b(sound\s*effect|sfx)\b/i.test(message)) {
    return null;
  }
  
  // Check for artist-only requests (when user asks for any song by a specific artist)
  const artistOnlyPattern = /\b(?:can\s+you\s+)?(?:sing|play)(?:\s+a)?\s+(?:song|track)(?:\s+by|\s+from)\s+["']?([^"\'?]+)["']?/i;
  const artistOnlyMatch = message.match(artistOnlyPattern);
  
  if (artistOnlyMatch) {
    const artist = artistOnlyMatch[1].trim();
    // If artist looks valid (not too short, not just "the", etc.)
    if (artist && artist.length > 2 && !['the', 'an', 'a'].includes(artist.toLowerCase())) {
      // User-specified transposeValue is already parsed and available in the `transposeValue` variable
      return {
        songName: `A song by ${artist}`,
        artist: artist,
        query: `popular song by ${artist}`,
        transposeValue: transposeValue // Pass user-specified transposeValue directly
      };
    }
  }
  
  // Check for specific song requests
  const specificSongPattern = /\b(?:sing|cover|perform|play)\s+(?:the\s+song\s+)?["\']?([^"\']+)["\']?(?:\s+by|\s+from)\s+["\']?([^"\'?]+)["\']?/i;
  const specificSongMatch = message.match(specificSongPattern);
  
  if (specificSongMatch) {
    const songName = specificSongMatch[1].trim();
    const artist = specificSongMatch[2].trim();
    
    if (songName && artist) {
      // User-specified transposeValue is already parsed and available in the `transposeValue` variable
      return {
        songName,
        artist,
        query: `${songName} by ${artist}`,
        transposeValue: transposeValue // Pass user-specified transposeValue directly
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
          query: songName,
          transposeValue: transposeValue
        };
      }
    }
  }
  
  return null;
}

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/ai-voice-chat";
let db;
let messagesCollection;

// Connect to MongoDB
async function connectToMongoDB() {
  try {
    const client = new MongoClient(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    await client.connect();
    console.log('Connected to MongoDB');
    db = client.db('ai-voice-chat');
    messagesCollection = db.collection('messages');
    
    // Create indexes for querying
    await messagesCollection.createIndex({ timestamp: -1 });
    await messagesCollection.createIndex({ username: 1 });
    
    return client;
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error);
    return null;
  }
}

// Store message in MongoDB
async function storeMessage(data) {
  if (!messagesCollection) {
    console.warn('MongoDB not connected, message not stored');
    return;
  }
  
  try {
    const result = await messagesCollection.insertOne({
      ...data,
      timestamp: new Date()
    });
    console.log(`Message stored in MongoDB with ID: ${result.insertedId}`);
    return result.insertedId;
  } catch (error) {
    console.error('Error storing message in MongoDB:', error);
    return null;
  }
}

// FISH AUDIO API settings
const FISH_AUDIO_API_KEY = process.env.FISHAUDIO_KEY || "";
const REFERENCE_ID = process.env.VOICE_ID || "";
const VOICE_MODEL = process.env.FISH_AUDIO_MODEL || "speech-1.6";
const AUDIO_DIRECTORY = path.join(__dirname, 'audio-cache');

// Ensure audio cache directory exists
if (!fs.existsSync(AUDIO_DIRECTORY)) {
  fs.mkdirSync(AUDIO_DIRECTORY, { recursive: true });
}

// Console-based TTS system
class ConsoleTTS {
  constructor() {
    // Regular HTTP session for simple requests
    this.session = new Session(FISH_AUDIO_API_KEY);
    
    // WebSocket session for streaming
    this.wsSession = new WebSocketSession(FISH_AUDIO_API_KEY);
    
    // Tracking state
    this.isReady = true;
    this.pendingRequests = [];
    this.currentRequest = null;
    this.audioCounter = 0;
    this.isSpeaking = false;
    
    console.log('Fish Audio TTS initialized');
  }
  
  async speak(text) {
    if (!text || text.trim().length === 0) {
      console.log('Empty text provided, skipping TTS');
      return Promise.resolve();
    }
    
    return new Promise(async (resolve, reject) => {
      try {
        // If already speaking, queue this request
        if (this.isSpeaking || this.currentRequest) {
          console.log('Queuing TTS request');
          this.pendingRequests.push({ text, resolve, reject });
          return;
        }
        
        this.isSpeaking = true;
        this.currentRequest = text;
        console.log(`Speaking text: "${text.substring(0, 40)}${text.length > 40 ? '...' : ''}"`);
        
        // Create random filename for caching
        const timestamp = Date.now();
        const audioCounter = this.audioCounter++;
        const audioFilename = `tts_${timestamp}_${audioCounter}.mp3`;
        const audioPath = path.join(AUDIO_DIRECTORY, audioFilename);
        
        // Create file write stream
        const fileStream = fs.createWriteStream(audioPath);
        
        // Create TTS request
        const ttsRequest = new TTSRequest(text, {
          format: 'mp3',
          referenceId: REFERENCE_ID,
          mp3Bitrate: 192, // Higher quality
          normalize: true,
          latency: 'balanced'
        });
        
        // Use additional headers to set model
        const additionalHeaders = {
          'model': VOICE_MODEL
        };
        
        // Send to browser clients that text is coming
        updateSubtitle(text);
        
        // Stream directly to file
        let totalBytes = 0;
        for await (const chunk of this.session.tts(ttsRequest, additionalHeaders)) {
          fileStream.write(chunk);
          totalBytes += chunk.length;
          
          // Also send to browser clients if they're connected
          io.emit('audio-chunk', {
            chunk: chunk.toString('base64'),
            timestamp: Date.now()
          });
        }
        
        fileStream.end();
        
        // Wait for file to finish writing
        await new Promise(resolveFile => fileStream.on('finish', resolveFile));
        
        console.log(`TTS complete: ${totalBytes} bytes written to ${audioFilename}`);
        
        // Play the audio through system speakers and wait for completion
        await soundPlay.play(audioPath);
        
        console.log('Audio playback complete');
        
        // Let clients know we're done
        io.emit('audio-finished');
        
        // Reset state
        this.isSpeaking = false;
        this.currentRequest = null;
        
        // Resolve the promise
        resolve();
        
        // Process next in queue if any
        setTimeout(() => {
          if (this.pendingRequests.length > 0) {
            const next = this.pendingRequests.shift();
            this.speak(next.text).then(next.resolve).catch(next.reject);
          }
        }, 500); // Small delay to ensure everything is cleaned up
      } catch (error) {
        console.error('TTS Error:', error);
        this.currentRequest = null;
        this.isSpeaking = false;
        
        // Reject the promise
        reject(error);
        
        // Try to process the next request despite error
        setTimeout(() => {
          if (this.pendingRequests.length > 0) {
            const next = this.pendingRequests.shift();
            this.speak(next.text).then(next.resolve).catch(next.reject);
          }
        }, 500);
      }
    });
  }
  
  async streamSpeak(text) {
    console.log(`Stream speaking: "${text.substring(0, 40)}${text.length > 40 ? '...' : ''}"`);
    
    try {
      // Create temporary audio file
      const timestamp = Date.now();
      const audioCounter = this.audioCounter++;
      const audioFilename = `tts_stream_${timestamp}_${audioCounter}.mp3`;
      const audioPath = path.join(AUDIO_DIRECTORY, audioFilename);
      const fileStream = fs.createWriteStream(audioPath);
      
      // Stream generator function for WebSocket TTS
      async function* textStream() {
        yield text;
      }
      
      // Create TTS request
      const ttsRequest = new TTSRequest('', {
        format: 'mp3',
        referenceId: REFERENCE_ID,
        mp3Bitrate: 192,
        normalize: true,
        latency: 'balanced'
      });
      
      // Send to browser clients that text is coming
      updateSubtitle(text);
      
      // Stream TTS to file and send chunks to browser
      let totalBytes = 0;
      for await (const chunk of this.wsSession.tts(ttsRequest, textStream())) {
        fileStream.write(chunk);
        totalBytes += chunk.length;
        
        // Also send to browser clients if they're connected
        io.emit('audio-chunk', {
          chunk: chunk.toString('base64'),
          timestamp: Date.now()
        });
      }
      
      fileStream.end();
      
      // Wait for file to finish writing
      await new Promise(resolve => fileStream.on('finish', resolve));
      
      console.log(`TTS streaming complete: ${totalBytes} bytes written to ${audioFilename}`);
      
      // Play the audio through system speakers
      await soundPlay.play(audioPath);
      
      console.log('Audio playback complete');
      
      // Let clients know we're done
      io.emit('audio-finished');
      
      return true;
    } catch (error) {
      console.error('TTS Streaming Error:', error);
      throw error;
    }
  }
  
  close() {
    try {
      if (this.session) {
        this.session.close();
      }
      if (this.wsSession) {
        this.wsSession.close();
      }
    } catch (error) {
      console.error('Error closing TTS sessions:', error);
    }
  }
}

// Initialize TTS engine
tts = new ConsoleTTS();

// Initialize Twitch client
const twitchClient = new tmi.Client({
  options: { debug: true },
  identity: {
    username: 'thatoneaistreamer',
    password: process.env.TWITCH_OAUTH_TOKEN ? 
      (process.env.TWITCH_OAUTH_TOKEN.startsWith('oauth:') ? 
        process.env.TWITCH_OAUTH_TOKEN : 
        `oauth:${process.env.TWITCH_OAUTH_TOKEN}`) : 
      undefined
  },
  channels: ['thatoneaistreamer']
});

// System prompt for the AI
let SYSTEM_PROMPT = "";

// Read system prompt from file
try {
  SYSTEM_PROMPT = fs.readFileSync('prompt.txt', 'utf8');
  console.log('System prompt loaded from prompt.txt');
} catch (error) {
  console.error('Failed to load system prompt from file:', error);
  // Default fallback prompt in case file cannot be read
  SYSTEM_PROMPT = `You are Kuromi Serika, a student from Abydos High School in Blue Archive. You are talking to viewers on a Twitch stream.
  You're 18 years old, have light blue hair, and are very serious, pragmatic, and money-conscious.
  Your speech pattern is blunt, direct, and sometimes impatient. You often sound tired or exasperated.
  You frequently complain about money problems and are constantly thinking of ways to save or earn funds.
  Keep your responses concise and to the point - you don't like wasting time or words.`;
}

let conversationHistory = [];

// Add conversation history management
function addToConversationHistory(role, content) {
  conversationHistory.push({ role, content });
  // Keep history limited to last 10 messages to avoid token limits
  if (conversationHistory.length > 10) {
    conversationHistory = conversationHistory.slice(conversationHistory.length - 10);
  }
}

// Function to generate AI response
async function generateAIResponse(message, username, isAutoTalk = false) {
  try {
    // Special handling for stall messages during song processing
    const isStallMessage = username === "System" && 
                          aiState.isProcessingSong && 
                          (message.includes("hype up chat") || 
                           message.includes("still processing") || 
                           message.includes("taking a while"));
    
    // If we're processing a song or singing, queue messages unless it's a stall message
    if ((aiState.isProcessingSong || aiState.isSinging) && !isStallMessage) {
      console.log(`${username}'s message queued because AI is ${aiState.isProcessingSong ? 'processing a song' : 'singing'}`);
      
      // Don't queue auto-talk messages
      if (!isAutoTalk) {
        aiState.messageQueue.push({ message, username });
      }
      
      return null;
    }
    
    // Set speaking state
    aiState.isSpeaking = true;
    aiState.lastSpoke = Date.now();
    
    try {
      const contextMessage = `${username} says: ${message}`;
      addToConversationHistory("user", contextMessage);
      
      // Store user message in MongoDB
      await storeMessage({
        type: 'user',
        username: username,
        content: message,
        fullContext: contextMessage
      });
      
      // Get user message history if available
      let userMessageHistory = [];
      if (messagesCollection && username !== 'System') {
        try {
          // Get the last 5 messages from this user
          userMessageHistory = await messagesCollection.find({
            username: username
          }).sort({ timestamp: -1 }).limit(5).toArray();
          
          // Reverse to get chronological order
          userMessageHistory.reverse();
        } catch (dbError) {
          console.error('Error fetching user message history:', dbError);
        }
      }
      
      // Create a list of available sounds to include in the system prompt
      const soundsList = Object.keys(availableSounds).length > 0 
        ? `\nAVAILABLE SOUND EFFECTS:\n${Object.keys(availableSounds).join(', ')}\n\nYou can play sound effects using @sound("sound-name", "times") syntax, where "times" is optional and defaults to 1. Example: @sound("vineboom", "3")`
        : '';
      
      // Add singing function to the prompt
      const singFunction = `\nSING FUNCTION:\nYou can sing songs using the @sing("song name", "artist") syntax. Use this to initiate singing a song. Example: @sing("Closer", "The Chainsmokers")`;
      
      // Add context about the AI's current state
      let stateContext = '';
      if (isAutoTalk) {
        stateContext = '\nYou have decided to talk on your own without being prompted. Say something spontaneous, short, and in-character.';
      }
      
      // Add user context
      let userContext = '';
      if (userMessageHistory.length > 0 && username !== 'System') {
        userContext = `\nUSER CONTEXT for ${username}:\nThis user has chatted with you ${userMessageHistory.length} times. `;
        
        if (userMessageHistory.length > 1) {
          userContext += `Here are some of their previous messages:\n`;
          userMessageHistory.forEach((msg, index) => {
            if (index < 3) { // Limit to 3 previous messages
              userContext += `- "${msg.content}"\n`;
            }
          });
          userContext += `Use this context to personalize your response to ${username}.`;
        } else {
          userContext += `This appears to be their first message.`;
        }
      }
      
      const fullPrompt = SYSTEM_PROMPT + soundsList + singFunction + stateContext + userContext;
      
      const fullConversation = [
        { role: "system", content: fullPrompt },
        ...conversationHistory
      ];
  
      // Reset subtitle and audio state
      updateSubtitle("Thinking...");
      io.emit('reset-audio');
  
      const completion = await openai.chat.completions.create({
        model: MODEL,
        messages: fullConversation,
        max_tokens: 150,
        temperature: 0.7,
        stream: true
      });
  
      let fullResponse = "";
      
      // Stream the response with better error handling
      try {
        for await (const chunk of completion) {
          // Safer property access with optional chaining
          const content = chunk?.choices?.[0]?.delta?.content || "";
          if (content) {
            fullResponse += content;
            updateSubtitle(fullResponse);
          }
        }
        
        // Parse response for sound effects and song commands before saving and speaking
        const { cleanText, soundCommands, songCommands } = parseResponseForSoundEffects(fullResponse);
        
        // Update the subtitle with the clean text (without sound commands)
        updateSubtitle(cleanText);
        
        // Store AI response in MongoDB (save the clean text)
        await storeMessage({
          type: 'assistant',
          username: 'AI',
          content: cleanText,
          inResponseTo: username,
          isAutoTalk: isAutoTalk
        });
        
        // Process any sound effects first
        for (const command of soundCommands) {
          await playSoundEffect(command.soundName, command.times);
        }
        
        // Process any song commands
        if (songCommands.length > 0) {
          const songCommand = songCommands[0]; // Take the first song command
          console.log(`Processing song command: ${JSON.stringify(songCommand)}`);
          
          // Format the query with both song and artist if available
          const songQuery = songCommand.artist 
            ? `${songCommand.songName} by ${songCommand.artist}`
            : songCommand.songName;
            
          // Process the song request with the constructed query
          processSongRequest({
            songName: songCommand.songName,
            artist: songCommand.artist,
            query: songQuery
          }, username).then(result => {
            if (!result || !result.success) {
              console.error(`Failed to process song request: ${JSON.stringify(result)}`);
              // Let the AI respond to the failure
              generateAIResponse(
                `I tried to sing "${songQuery}" but it didn't work. ${result?.error || 'Could not find the song.'}`,
                'System'
              );
            }
          }).catch(err => {
            console.error('Error processing song command:', err);
          });
        }
        
        // Only try to speak the text after we have the complete response
        if (cleanText.trim()) {
          console.log(`Speaking clean response: "${cleanText.substring(0, 50)}${cleanText.length > 50 ? '...' : ''}"`);
          
          // Add retry logic for TTS with proper Promise handling
          let ttsSuccess = false;
          let attempts = 0;
          const maxAttempts = 3;
          
          while (!ttsSuccess && attempts < maxAttempts) {
            attempts++;
            try {
              // Use the improved TTS system with proper await
              await tts.speak(cleanText);
              ttsSuccess = true;
            } catch (ttsError) {
              console.error(`TTS attempt ${attempts} failed:`, ttsError);
              
              if (attempts < maxAttempts) {
                console.log(`Retrying TTS (attempt ${attempts + 1}/${maxAttempts})...`);
                // Wait a bit before retry
                await new Promise(resolve => setTimeout(resolve, 1000));
              } else {
                console.error("All TTS attempts failed");
                
                // Log this error to MongoDB
                await storeMessage({
                  type: 'error',
                  content: `TTS failed after ${maxAttempts} attempts: ${ttsError.message}`,
                  relatedTo: cleanText.substring(0, 100)
                });
                
                // Try a simple alternative
                try {
                  // Let users know there was an issue but we're still responding
                  const errorNote = "Audio playback error. Please see the text response.";
                  updateSubtitle(cleanText + "\n\n(" + errorNote + ")");
                } catch (e) {
                  console.error("Error updating subtitle with error note:", e);
                }
              }
            }
          }
        }
      } catch (streamError) {
        console.error("Error streaming AI response:", streamError);
        
        // Log streaming error to MongoDB
        await storeMessage({
          type: 'error',
          content: `Streaming error: ${streamError.message}`,
          partialResponse: fullResponse
        });
        
        throw new Error("Stream processing error");
      }
      
      // If we got no response, throw an error
      if (!fullResponse.trim()) {
        throw new Error("Empty response from AI");
      }
      
      // Parse the response again to get clean text for conversation history
      const { cleanText } = parseResponseForSoundEffects(fullResponse);
      
      // Add AI's clean response to conversation history
      addToConversationHistory("assistant", cleanText);
      
      return fullResponse;
    } finally {
      // Reset AI speaking state
      aiState.isSpeaking = false;
      
      // Check if we have a pending song to play now that we're done speaking
      if (aiState.pendingSong) {
        console.log(`✅ Speaking finished, playing pending song "${aiState.pendingSong.title}"`);
        const pendingSong = aiState.pendingSong;
        aiState.pendingSong = null; // Clear it before playing to avoid recursion issues
        
        // Small delay to ensure speech is fully complete
        setTimeout(async () => {
          await startSongPlayback(pendingSong.result, pendingSong.title, pendingSong.username);
        }, 500);
      } else {
        // Process any queued messages after we're done speaking
        // Add a small delay to ensure everything is reset properly
        setTimeout(() => {
          processNextInQueue();
        }, 1000);
      }
    }
  } catch (error) {
    console.error("Error generating AI response:", error);
    
    // Log error to MongoDB
    await storeMessage({
      type: 'error',
      content: `AI response error: ${error.message}`,
      username: username,
      userMessage: message
    });
    
    const errorMessage = "Please tell Pikachubolk there's a problem with my AI";
    updateSubtitle(errorMessage);
    
    try {
      // Also speak the error
      await tts.speak(errorMessage);
    } catch (ttsError) {
      console.error("Error with TTS when trying to speak error message:", ttsError);
    } finally {
      // Reset AI speaking state
      aiState.isSpeaking = false;
      
      // Process any queued messages
      setTimeout(processNextInQueue, 1000);
    }
    
    return errorMessage;
  }
}

// New functions for streaming TTS
let currentTTSText = "";
let ttsStreamActive = false;
let ttsPendingText = ""; // Store text while connection is being established

async function startStreamingTTS(initialText) {
  return new Promise(async (resolve, reject) => {
    try {
      currentTTSText = initialText;
      
      // First, ensure connection is established
      if (!tts.connected) {
        console.log("TTS not connected, establishing connection first...");
        ttsPendingText = initialText; // Store text while connecting
        
        try {
          await tts.ensureConnection();
          
          // Allow some time for the socket to stabilize even after connection is reported as open
          await new Promise(resolve => setTimeout(resolve, 1500));
        } catch (connectionError) {
          console.error("Failed to connect to TTS service:", connectionError);
          
          // Try fallback approach if connection fails
          try {
            await tts.speak(initialText);
            resolve();
            return;
          } catch (err) {
            console.error("Fallback TTS also failed:", err);
            reject(err);
            return;
          }
        }
      }
      
      // Double-check connection state
      if (!tts.ws || tts.ws.readyState !== WebSocket.OPEN) {
        console.error("WebSocket not ready after connect, falling back to regular TTS");
        try {
          await tts.speak(initialText);
          resolve();
        } catch (err) {
          console.error("Fallback TTS also failed:", err);
          reject(err);
        }
        return;
      }
      
      console.log(`Starting TTS stream with text: "${initialText.substring(0, 50)}${initialText.length > 50 ? '...' : ''}"`);
      
      // Start streaming now that we have a reliable connection
      ttsStreamActive = true;
      tts.chunkBuffer = []; // Reset buffer
      
      // Send a dummy packet to ensure connection is working
      try {
        console.log("Sending ping packet to test connection...");
        tts.ws.ping();
      } catch (pingError) {
        console.error("Failed to ping WebSocket:", pingError);
      }
      
      // Set up event listener for stream completion
      const completionHandler = () => {
        console.log("TTS stream completed");
        ttsStreamActive = false;
        resolve();
      };
      
      // Start the TTS process
      tts.ws.send(msgpack.encode({
        event: 'start',
        request: {
          text: "",
          chunk_length: 200,
          format: 'mp3',
          mp3_bitrate: 128,
          reference_id: VOICE_ID,
          normalize: true,
          latency: 'balanced'
        }
      }));
      
      // Send the initial text
      tts.ws.send(msgpack.encode({
        event: 'text',
        text: initialText
      }));
      
      // Send stop event to finalize
      tts.ws.send(msgpack.encode({
        event: 'stop'
      }));
      
      console.log("TTS streaming started successfully");
      
      // Set a timeout to check if we received any audio chunks
      setTimeout(() => {
        if (ttsStreamActive && tts.chunkBuffer.length === 0) {
          console.warn("No audio chunks received after 5 seconds, there might be an issue with TTS");
          
          // Try a regular API call as fallback if streaming fails
          console.log("Attempting fallback to regular TTS call...");
          ttsStreamActive = false;
          tts.speak(initialText)
            .then(resolve)
            .catch(error => {
              console.error("Fallback TTS also failed:", error);
              reject(error);
            });
        } else if (ttsStreamActive) {
          // If chunks were received but stream is still active, set a timeout to complete
          setTimeout(() => {
            if (ttsStreamActive) {
              console.log("TTS stream timed out, considering it complete");
              ttsStreamActive = false;
              resolve();
            }
          }, 10000); // 10 seconds max stream time
        }
      }, 5000);
    } catch (error) {
      console.error("Error starting TTS stream:", error);
      ttsStreamActive = false;
      
      // Try to use regular speakText as fallback
      try {
        await tts.speak(initialText);
        resolve();
      } catch (fallbackError) {
        console.error("Fallback TTS also failed:", fallbackError);
        reject(fallbackError);
      }
    }
  });
}

async function sendTTSChunk(newText) {
  try {
    if (!ttsStreamActive) return;
    
    // Only try to send if WebSocket is open
    if (tts.ws && tts.ws.readyState === WebSocket.OPEN) {
      // Send the new text chunk
      tts.ws.send(msgpack.encode({
        event: 'text',
        text: newText
      }));
      
      // Update the current text
      currentTTSText += newText;
    } else {
      console.warn("WebSocket not open, cannot send TTS chunk");
      
      // Store the text while we try to reconnect
      ttsPendingText += newText;
      
      // Try to reconnect if needed
      if (!tts.connected) {
        try {
          // Don't wait on this to unblock the main flow
          await tts.ensureConnection().then(() => {
            // If we have pending text and connection is successful, send it
            if (ttsPendingText && tts.ws && tts.ws.readyState === WebSocket.OPEN) {
              tts.ws.send(msgpack.encode({
                event: 'text',
                text: ttsPendingText
              }));
              console.log("Sent pending TTS chunks after reconnect");
              ttsPendingText = "";
            }
          }).catch(err => {
            console.error("Failed to reconnect TTS:", err);
          });
        } catch (connErr) {
          console.error("Error initiating TTS reconnect:", connErr);
        }
      }
    }
  } catch (error) {
    console.error("Error sending TTS chunk:", error);
  }
}

async function finalizeTTSStream() {
  try {
    if (!ttsStreamActive) return;
    
    // Only try to stop if WebSocket is open
    if (tts.ws && tts.ws.readyState === WebSocket.OPEN) {
      // Send stop event to finalize the TTS stream
      tts.ws.send(msgpack.encode({
        event: 'stop'
      }));
      console.log("TTS stream finalized successfully");
    } else {
      console.warn("WebSocket not open, cannot finalize TTS stream");
      
      // If we have pending text that wasn't sent, try to use speakText as fallback
      if (ttsPendingText) {
        try {
          await tts.speak(ttsPendingText);
          ttsPendingText = "";
        } catch (fallbackError) {
          console.error("Failed to speak pending text:", fallbackError);
        }
      }
    }
  } catch (error) {
    console.error("Error finalizing TTS stream:", error);
  } finally {
    ttsStreamActive = false;
  }
}

// Function to update subtitle
function updateSubtitle(text) {
  currentSubtitle = text;
  io.emit('subtitle-update', text);
}

// Connect to Twitch only if we have a token
if (process.env.TWITCH_OAUTH_TOKEN) {
  twitchClient.connect().catch(console.error);
  console.log('Connecting to Twitch chat...');
} else {
  console.log('No Twitch OAuth token provided. Twitch chat integration disabled.');
  console.log('Set the TWITCH_OAUTH_TOKEN environment variable to enable Twitch chat.');
  console.log('Get your token from: https://twitchapps.com/tmi/');
}

// Handle Twitch chat messages
twitchClient.on('message', async (channel, tags, message, self) => {
  if (self) return; // Ignore messages from the bot itself
  
  // Get the display name of the user who sent the message
  const username = tags['display-name'];
  
  console.log(`${username}: ${message}`);
  
  // Track the last chat activity time
  aiState.lastChatActivity = Date.now();
  
  // If the AI is busy speaking, processing a song, singing, or handling queue, queue this message
  if (aiState.isSpeaking || aiState.isProcessingSong || aiState.isSinging || aiState.isProcessingQueue) {
    console.log(`${username}'s message queued because AI is busy`);
    aiState.messageQueue.push({ message, username });
    return;
  }
  
  // Check for direct sing/song commands first
  const directSongPattern = /^!(sing|play)\s+(.+)$/i;
  const directMatch = message.match(directSongPattern);
  
  if (directMatch) {
    const songQuery = directMatch[2].trim();
    console.log(`Direct song command detected: ${songQuery}`);
    
    // Check for transpose instruction in the command
    let transposeValue = null;
    const transposePattern = /transpose[:\s]+([+-]?\d+)/i;
    const transposeMatch = songQuery.match(transposePattern);
    
    if (transposeMatch) {
      transposeValue = parseInt(transposeMatch[1], 10);
      console.log(`Manual transpose value detected in direct command: ${transposeValue} semitones`);
      
      // Limit to reasonable range (-12 to +12 semitones)
      transposeValue = Math.max(-12, Math.min(12, transposeValue));
    }
    
    // Check if the query contains a YouTube URL
    const youtubeUrlRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/|music\.youtube\.com\/(?:watch\?v=))([a-zA-Z0-9_-]+)(?:&\S*)?/;
    const youtubeMatch = songQuery.match(youtubeUrlRegex);
    
    if (youtubeMatch) {
      // If it's a YouTube URL, process it directly
      const videoId = youtubeMatch[1];
      // Get the original URL from the query
      const originalUrl = songQuery.substring(youtubeMatch.index, youtubeMatch.index + youtubeMatch[0].length);
      // Ensure it has https:// prefix
      const fullUrl = originalUrl.startsWith('http') ? originalUrl : `https://${originalUrl}`;
      
      console.log(`YouTube URL detected in direct command: ${fullUrl}`);
      
      // Tell everyone we're processing the song request
      updateSubtitle(`${username} requested a YouTube video`);
      
      // Generate AI response about singing
      await generateAIResponse(`I've been asked to play a video from YouTube. Give a reluctant response about having to do this.`, "System");
      
      // Process as a direct YouTube video request - use the full URL as is
      const result = await processSongRequest({
        songName: 'YouTube Video',
        youtubeUrl: fullUrl,
        videoId: videoId,
        directYouTubeLink: true,
        query: fullUrl, // This will be ignored for direct URLs
        useVideoTitle: true,
        transposeValue: transposeValue // Add the transpose value if specified
      }, username);
      
      if (!result.success) {
        // If there was an error, let everyone know and respond with AI
        updateSubtitle(`Song request failed`);
        
        // Generate an AI response to the failed song request
        const response = await generateAIResponse(
          `I tried to play that YouTube video but it didn't work. ${result.error}`, 
          "System"
        );
      }
      return;
    }
    
    // Remove any transpose instructions from the displayed query
    const cleanSongQuery = songQuery.replace(transposePattern, '').trim();
    
    // Tell everyone we're processing the song request
    updateSubtitle(`${username} requested a song: ${cleanSongQuery}`);
    
    // Generate AI response about singing
    await generateAIResponse(`I've been asked to sing "${cleanSongQuery}". Give a reluctant response about having to sing this.`, "System");
    
    // Process as a direct song request
    const result = await processSongRequest({
      songName: cleanSongQuery,
      query: cleanSongQuery,
      transposeValue: transposeValue // Add the transpose value if specified
    }, username);
    
    if (!result.success) {
      // If there was an error, let everyone know and respond with AI
      updateSubtitle(`Song request failed`);
      
      // Generate an AI response to the failed song request
      const response = await generateAIResponse(
        `I tried to sing "${cleanSongQuery}" but it didn't work. ${result.error}`, 
        "System"
      );
    }
    return;
  }
  
  // First check if this is a song request using standard patterns
  const songRequest = parseSongRequest(message);
  if (songRequest) {
    console.log(`Detected song request: ${songRequest.query}`);
    
    // Tell everyone we're processing the song request
    updateSubtitle(`${username} requested a song`);
    
    // Generate AI response about singing
    const songTitle = typeof songRequest === 'object' ? 
      (songRequest.songName || songRequest.query || 'Unknown Song') : 
      songRequest;
    
    await generateAIResponse(`I've been asked to sing "${songTitle}". Give a reluctant response about having to sing this.`, "System");
    
    // Process the song request
    const result = await processSongRequest(songRequest, username);
    
    if (!result.success) {
      // If there was an error, let everyone know and respond with AI
      updateSubtitle(`Song request failed`);
      
      // Generate an AI response to the failed song request
      const response = await generateAIResponse(
        `I tried to sing "${songTitle}" but it didn't work. ${result.error}`, 
        "System"
      );
    }
    return;
  }
  
  // Process commands or generate AI response
  if (message.startsWith('!')) {
    const command = message.split(' ')[0].toLowerCase();
    
    switch (command) {
      case '!hello':
        updateSubtitle(`Hello, ${username}!`);
        await tts.speak(`Hello, ${username}!`);
        break;
        
      case '!help':
        const helpText = "I'm an AI assistant for this stream. You can chat with me normally or use commands like !hello or !help.";
        updateSubtitle(helpText);
        await tts.speak(helpText);
        break;
      
      case '!autotalk':
        // Toggle the auto-talk feature (for moderators or the broadcaster)
        if (tags.mod || tags.username === 'pikachubolk') {
          const param = message.split(' ')[1]?.toLowerCase();
          
          if (param === 'on') {
            aiState.autoTalkEnabled = true;
            updateSubtitle('Auto-talk feature enabled');
            await tts.speak('Auto-talk feature enabled. I will speak on my own occasionally.');
            scheduleNextAutoTalk(); // Schedule the next auto-talk
          } else if (param === 'off') {
            aiState.autoTalkEnabled = false;
            updateSubtitle('Auto-talk feature disabled');
            await tts.speak('Auto-talk feature disabled. I will only speak when spoken to.');
          } else {
            // Just toggle the current state
            aiState.autoTalkEnabled = !aiState.autoTalkEnabled;
            const stateText = aiState.autoTalkEnabled ? 
              'Auto-talk feature enabled. I will speak on my own occasionally.' : 
              'Auto-talk feature disabled. I will only speak when spoken to.';
            updateSubtitle(stateText);
            await tts.speak(stateText);
            
            if (aiState.autoTalkEnabled) {
              scheduleNextAutoTalk(); // Schedule the next auto-talk if turned on
            }
          }
        } else {
          updateSubtitle(`Sorry ${username}, only moderators can control the auto-talk feature.`);
          await tts.speak(`Sorry ${username}, only moderators can control the auto-talk feature.`);
        }
        break;
        
      case '!clearqueue':
        // Allow moderators to clear the message queue
        if (tags.mod || tags.username === 'pikachubolk') {
          const queueLength = aiState.messageQueue.length;
          aiState.messageQueue = [];
          updateSubtitle(`Message queue cleared (${queueLength} messages removed)`);
          await tts.speak(`Message queue cleared. ${queueLength} messages removed.`);
        } else {
          updateSubtitle(`Sorry ${username}, only moderators can clear the message queue.`);
          await tts.speak(`Sorry ${username}, only moderators can clear the message queue.`);
        }
        break;
      
      default:
        // For unrecognized commands, respond with AI
        const response = await generateAIResponse(message, username);
        if (response) {
          console.log(`AI Response to ${username}: ${response}`);
        }
    }
  } else {
    // For regular messages, respond with AI
    const response = await generateAIResponse(message, username);
    if (response) {
      console.log(`AI Response to ${username}: ${response}`);
    }
  }
});

// Setup Express routes
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Serve sound effects directory
app.use('/sound-effects', express.static(path.join(__dirname, 'sound-effects')));

// Serve song cache directory
app.use('/song-cache', express.static(path.join(__dirname, 'song-cache')));

// API endpoint for song conversion testing
app.post('/api/convert-song', async (req, res) => {
  try {
    const { songName, artist } = req.body;
    
    if (!songName) {
      return res.status(400).json({
        success: false,
        error: 'Song name is required'
      });
    }
    
    // Build the search query
    const query = artist ? `${songName} by ${artist}` : songName;
    
    // Process the song request
    const result = await processSongRequest(query, 'TestUser');
    
    return res.json(result);
  } catch (error) {
    console.error('Error in /api/convert-song:', error);
    return res.status(500).json({
      success: false,
      error: `Server error: ${error.message}`
    });
  }
});

// API endpoint to list available sound effects
app.get('/api/sound-effects', (req, res) => {
  try {
    // If availableSounds is empty, try to reload
    if (Object.keys(availableSounds).length === 0) {
      loadAvailableSounds();
    }
    
    const soundsList = Object.keys(availableSounds);
    res.json({
      success: true,
      sounds: soundsList
    });
  } catch (error) {
    console.error('Error fetching sound effects:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch sound effects'
    });
  }
});

// API endpoint to play a specific sound effect
app.post('/api/play-sound', async (req, res) => {
  const { sound, times = 1 } = req.body;
  
  if (!sound) {
    return res.status(400).json({ success: false, error: 'Sound name is required' });
  }
  
  try {
    const success = await playSoundEffect(sound, times);
    
    if (success) {
      return res.json({ success: true });
    } else {
      return res.status(404).json({ 
        success: false, 
        error: `Sound "${sound}" not found`
      });
    }
  } catch (error) {
    console.error('Error playing sound effect:', error);
    return res.status(500).json({
      success: false,
      error: 'Error playing sound effect'
    });
  }
});

// Test audio endpoint
app.get('/api/test-audio', (req, res) => {
  console.log('Test audio endpoint called');
  
  // Create a simple MP3 file path
  const testAudioPath = path.join(__dirname, 'public', 'test-audio.mp3');
  
  // Check if we already have a test audio file
  if (!fs.existsSync(testAudioPath)) {
    console.log('Creating test audio message');
    
    // Generate a test message with TTS
    tts.speak("This is a test of the text to speech system.")
      .then(audioBuffer => {
        // Save the audio buffer to a file
        fs.writeFileSync(testAudioPath, audioBuffer);
        console.log('Test audio file created successfully');
      })
      .catch(error => {
        console.error('Error creating test audio:', error);
      });
    
    // Send a response that the file is being generated
    return res.json({ 
      success: true, 
      message: 'Test audio is being generated. Try again in a few seconds.' 
    });
  }
  
  // If the file exists, serve it
  res.sendFile(testAudioPath);
});

// Serve subtitle page
app.get('/subtitles', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'subtitles.html'));
});

// Serve audio page
app.get('/audio', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'audio.html'));
});

// Serve now-playing widget
app.get('/now-playing', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'now-playing.html'));
});

// Route to handle getting voice responses
app.post('/voice-response', async (req, res) => {
  const { username, text } = req.body;
  
  if (!username || !text) {
    return res.status(400).json({ error: 'Missing username or text' });
  }

  try {
    console.log(`Processing voice response request for ${username}: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
    
    // Track request start time for performance monitoring
    const startTime = Date.now();
    
    // Initialize flag for TTS success
    let ttsSucceeded = false;
    let retries = 0;
    const maxRetries = 2;
    let error = null;
    
    // Attempt TTS with retries
    while (!ttsSucceeded && retries <= maxRetries) {
      try {
        if (retries > 0) {
          console.log(`Retry attempt ${retries}/${maxRetries} for TTS...`);
          // Wait between retries with increasing backoff
          await new Promise(resolve => setTimeout(resolve, retries * 1000));
        }
        
        // Get AI response from Zuki
        const aiResponse = await generateAIResponse(text, username);
        console.log(`AI response generated: "${aiResponse.substring(0, 50)}${aiResponse.length > 50 ? '...' : ''}"`);
        
        // Stream the text response to all connected clients
        await streamTextResponse(aiResponse);
        
        // Attempt speech synthesis (with a timeout)
        const ttsPromise = tts.speak(aiResponse);
        
        // Set a global timeout for the entire TTS process
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('TTS operation timed out')), 20000)
        );
        
        // Wait for either TTS completion or timeout
        await Promise.race([ttsPromise, timeoutPromise]);
        
        // If we get here, TTS succeeded
        ttsSucceeded = true;
        console.log(`TTS completed successfully in ${Date.now() - startTime}ms`);
        
      } catch (err) {
        error = err;
        console.error(`TTS attempt ${retries+1} failed:`, err);
        retries++;
        
        // Close and reset TTS connection after failure
        tts.close();
        
        // If this was the last retry, send a fallback message to clients
        if (retries > maxRetries) {
          io.emit('subtitle', {
            text: "Voice system error. Please try again in a moment.",
            isComplete: true
          });
          io.emit('audio-finished');
        }
      }
    }
    
    // If all retries failed, log the final error but return a success response to the client
    if (!ttsSucceeded) {
      console.error('All TTS attempts failed:', error);
      // Still return OK to the client so UI doesn't get stuck
      return res.json({ 
        success: false, 
        message: 'TTS failed but text was displayed',
        error: error?.message || 'Unknown TTS error'
      });
    }
    
    // Return success
    return res.json({ success: true });
    
  } catch (error) {
    console.error('Error processing voice response:', error);
    res.status(500).json({ 
      error: 'Failed to process voice response', 
      details: error.message
    });
  }
});

// Create public directory and subtitle HTML page
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir);
}

// Create index.html for testing UI
const indexHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Voice Tester</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
    }
    h1 {
      color: #333;
    }
    .form-group {
      margin-bottom: 15px;
    }
    label {
      display: block;
      margin-bottom: 5px;
      font-weight: bold;
    }
    input, textarea {
      width: 100%;
      padding: 8px;
      box-sizing: border-box;
      border: 1px solid #ddd;
      border-radius: 4px;
    }
    button {
      background-color: #6441a5;
      color: white;
      border: none;
      padding: 10px 15px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 16px;
    }
    button:hover {
      background-color: #7d5bbe;
    }
    .subtitle-preview {
      margin-top: 20px;
      padding: 15px;
      background-color: #f5f5f5;
      border-radius: 4px;
      min-height: 50px;
    }
    .subtitle-example {
      margin-top: 20px;
      padding: 20px;
      background-color: rgba(0, 0, 0, 0.7);
      border-radius: 4px;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 120px;
      overflow: hidden;
    }
    #preview-text {
      color: white;
      -webkit-text-stroke: 2px #8A2BE2;
      text-stroke: 2px #8A2BE2;
      font-family: "Comic Sans MS", cursive, sans-serif;
      font-size: clamp(20px, 5vw, 40px);
      text-align: center;
      text-shadow: 3px 3px 5px rgba(0, 0, 0, 0.8);
      width: 100%;
      overflow-wrap: break-word;
      hyphens: auto;
      word-wrap: break-word;
    }
  </style>
</head>
<body>
  <h1>AI Voice Tester</h1>
  <p>Use this page to test the AI's voice without connecting to Twitch.</p>
  
  <div class="form-group">
    <label for="username">Username:</label>
    <input type="text" id="username" placeholder="Enter a username" value="Tester">
  </div>
  
  <div class="form-group">
    <label for="message">Message:</label>
    <textarea id="message" rows="4" placeholder="Type a message for the AI to respond to"></textarea>
  </div>
  
  <button id="sendBtn">Send Message</button>
  
  <div class="subtitle-preview">
    <h3>Current Text Response:</h3>
    <p id="subtitle-display">AI is ready to speak...</p>
  </div>
  
  <div class="subtitle-example">
    <p id="preview-text">AI is ready to speak...</p>
  </div>
  
  <audio id="audio-player" autoplay></audio>
  
  <p>View the <a href="/subtitles" target="_blank">subtitles page</a> for OBS.</p>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const socket = io();
    const sendBtn = document.getElementById('sendBtn');
    const usernameInput = document.getElementById('username');
    const messageInput = document.getElementById('message');
    const subtitleDisplay = document.getElementById('subtitle-display');
    const previewText = document.getElementById('preview-text');
    const audioPlayer = document.getElementById('audio-player');
    
    // Audio context for streaming audio
    let audioContext;
    let audioSource;
    let audioQueue = [];
    let isPlaying = false;
    
    // Initialize audio context on page load
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      console.log('Audio context initialized');
    } catch (e) {
      console.error('Failed to initialize audio context:', e);
    }
    
    // Update subtitle when it changes
    socket.on('subtitle-update', (text) => {
      subtitleDisplay.textContent = text;
      previewText.textContent = text;
      
      // Dynamic font size adjustment based on text length
      const textLength = text.length;
      if (textLength > 150) {
        previewText.style.fontSize = 'clamp(16px, 3vw, 32px)';
      } else if (textLength > 100) {
        previewText.style.fontSize = 'clamp(18px, 3.5vw, 36px)';
      } else if (textLength > 50) {
        previewText.style.fontSize = 'clamp(20px, 4vw, 38px)';
      } else {
        previewText.style.fontSize = 'clamp(20px, 5vw, 40px)';
      }
      
      // Check for overflow
      checkTextOverflow();
    });
    
    // Process audio chunks as they arrive
    socket.on('audio-chunk', (data) => {
      const audioData = atob(data.chunk);
      const arrayBuffer = new ArrayBuffer(audioData.length);
      const uint8Array = new Uint8Array(arrayBuffer);
      
      for (let i = 0; i < audioData.length; i++) {
        uint8Array[i] = audioData.charCodeAt(i);
      }
      
      if (audioContext) {
        // Decode and play the audio chunk
        audioContext.decodeAudioData(arrayBuffer, (buffer) => {
          audioQueue.push(buffer);
          if (!isPlaying) {
            playNextInQueue();
          }
        }).catch(err => {
          console.error('Error decoding audio data', err);
          
          // Fallback to old method
          tryFallbackAudio(uint8Array);
        });
      } else {
        // Fallback to old method using audio element
        tryFallbackAudio(uint8Array);
      }
    });
    
    function tryFallbackAudio(uint8Array) {
      try {
        const blob = new Blob([uint8Array], { type: 'audio/mp3' });
        const url = URL.createObjectURL(blob);
        audioPlayer.src = url;
        audioPlayer.play().catch(err => {
          console.error('Error playing audio:', err);
        });
      } catch (err) {
        console.error('Fallback audio failed:', err);
      }
    }
    
    socket.on('audio-finished', () => {
      console.log('Audio stream finished');
    });
    
    socket.on('reset-audio', () => {
      // Reset audio state
      audioQueue = [];
      isPlaying = false;
      if (audioSource) {
        audioSource.stop();
        audioSource = null;
      }
      audioPlayer.pause();
      audioPlayer.src = '';
    });
    
    function playNextInQueue() {
      if (audioQueue.length === 0) {
        isPlaying = false;
        return;
      }
      
      isPlaying = true;
      const buffer = audioQueue.shift();
      audioSource = audioContext.createBufferSource();
      audioSource.buffer = buffer;
      audioSource.connect(audioContext.destination);
      
      audioSource.onended = () => {
        playNextInQueue();
      };
      
      audioSource.start(0);
    }
    
    // Check if text is overflowing the container
    function checkTextOverflow() {
      const textElem = previewText;
      const container = textElem.parentElement;
      
      if (textElem.scrollWidth > container.clientWidth || 
          textElem.scrollHeight > container.clientHeight) {
        // Get current font size and reduce it
        const currentSize = parseFloat(getComputedStyle(textElem).fontSize);
        textElem.style.fontSize = (currentSize * 0.9) + 'px';
        
        // Check again if we need to reduce further
        if (textElem.scrollWidth > container.clientWidth ||
            textElem.scrollHeight > container.clientHeight) {
          setTimeout(checkTextOverflow, 10);
        }
      }
    }
    
    // Check on resize too
    window.addEventListener('resize', checkTextOverflow);
    
    // Send message to API
    sendBtn.addEventListener('click', async () => {
      const username = usernameInput.value.trim() || 'Tester';
      const message = messageInput.value.trim();
      
      if (!message) {
        alert('Please enter a message');
        return;
      }
      
      try {
        sendBtn.disabled = true;
        sendBtn.textContent = 'Processing...';
        
        const response = await fetch('/api/speak', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ username, message })
        });
        
        const data = await response.json();
        
        if (!data.success) {
          throw new Error(data.error || 'Unknown error');
        }
        
        messageInput.value = '';
      } catch (error) {
        console.error('Error:', error);
        alert('Error: ' + error.message);
      } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Message';
      }
    });
  </script>
</body>
</html>
`;

fs.writeFileSync(path.join(publicDir, 'index.html'), indexHTML);

// Update subtitle HTML with better text scaling
const subtitleHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Subtitles</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      overflow: hidden;
      background-color: transparent;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      font-family: "Comic Sans MS", cursive, sans-serif;
    }
    
    #subtitle {
      color: white;
      -webkit-text-stroke: 2px #8A2BE2; /* Purple outline for text */
      text-stroke: 2px #8A2BE2;
      font-size: clamp(20px, 5vw, 60px); /* Responsive font size with min and max limits */
      text-align: center;
      width: 90vw; /* Limit width to ensure it fits on screen */
      word-wrap: break-word; /* Ensure text wraps */
      line-height: 1.3;
      margin: 0 auto;
      text-shadow: 3px 3px 5px rgba(0, 0, 0, 0.8);
      transition: font-size 0.3s ease;
      overflow-wrap: break-word;
      hyphens: auto;
    }
    
    /* Media queries for better scaling */
    @media (min-width: 1200px) {
      #subtitle {
        font-size: 60px; /* Max font size */
        max-width: 1000px; /* Limit width on large screens */
      }
    }
    
    @media (max-width: 768px) {
      #subtitle {
        font-size: 7vw; /* Larger relative font on smaller screens */
      }
    }
    
    @media (max-width: 480px) {
      #subtitle {
        font-size: 8vw; /* Even larger for very small screens */
      }
    }
    
    #audio-player {
      position: fixed;
      bottom: 0;
      left: 0;
      opacity: 0;
      height: 1px;
      width: 1px;
    }
  </style>
</head>
<body>
  <div id="subtitle">AI is ready to speak...</div>
  <audio id="audio-player" autoplay></audio>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const socket = io();
    const subtitleElement = document.getElementById('subtitle');
    const audioPlayer = document.getElementById('audio-player');
    
    // Audio context for streaming audio
    let audioContext;
    let audioSource;
    let audioQueue = [];
    let isPlaying = false;
    
    // Initialize audio context on user interaction
    document.body.addEventListener('click', initAudio, { once: true });
    
    function initAudio() {
      try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        console.log('Audio context initialized');
      } catch (e) {
        console.error('Failed to initialize audio context:', e);
      }
    }
    
    // Process audio chunks as they arrive
    socket.on('audio-chunk', (data) => {
      const audioData = atob(data.chunk);
      const arrayBuffer = new ArrayBuffer(audioData.length);
      const uint8Array = new Uint8Array(arrayBuffer);
      
      for (let i = 0; i < audioData.length; i++) {
        uint8Array[i] = audioData.charCodeAt(i);
      }
      
      if (audioContext) {
        // Decode and play the audio chunk
        audioContext.decodeAudioData(arrayBuffer, (buffer) => {
          audioQueue.push(buffer);
          if (!isPlaying) {
            playNextInQueue();
          }
        }).catch(err => {
          console.error('Error decoding audio data', err);
          
          // Fallback to audio element if decoding fails
          tryFallbackAudio(uint8Array);
        });
      } else {
        // Fallback to old method using audio element
        tryFallbackAudio(uint8Array);
      }
    });
    
    function tryFallbackAudio(uint8Array) {
      try {
        const blob = new Blob([uint8Array], { type: 'audio/mp3' });
        const url = URL.createObjectURL(blob);
        audioPlayer.src = url;
        audioPlayer.play().catch(err => {
          console.error('Error playing audio:', err);
          // Initialize audio context on error, might be needed for autoplay
          initAudio();
        });
      } catch (err) {
        console.error('Fallback audio failed:', err);
      }
    }
    
    socket.on('audio-finished', () => {
      console.log('Audio stream finished');
    });
    
    socket.on('reset-audio', () => {
      // Reset audio state
      audioQueue = [];
      isPlaying = false;
      if (audioSource) {
        audioSource.stop();
        audioSource = null;
      }
      audioPlayer.pause();
      audioPlayer.src = '';
    });
    
    function playNextInQueue() {
      if (audioQueue.length === 0) {
        isPlaying = false;
        return;
      }
      
      isPlaying = true;
      const buffer = audioQueue.shift();
      audioSource = audioContext.createBufferSource();
      audioSource.buffer = buffer;
      audioSource.connect(audioContext.destination);
      
      audioSource.onended = () => {
        playNextInQueue();
      };
      
      audioSource.start(0);
    }
    
    // Update subtitle when it changes
    socket.on('subtitle-update', (text) => {
      subtitleElement.textContent = text;
      
      // Dynamic font size adjustment based on text length
      const textLength = text.length;
      if (textLength > 150) {
        subtitleElement.style.fontSize = 'clamp(16px, 3vw, 40px)';
      } else if (textLength > 100) {
        subtitleElement.style.fontSize = 'clamp(18px, 3.5vw, 50px)';
      } else if (textLength > 50) {
        subtitleElement.style.fontSize = 'clamp(20px, 4vw, 55px)';
      } else {
        subtitleElement.style.fontSize = 'clamp(20px, 5vw, 60px)'; // Default
      }
    });
    
    // Periodically check if subtitle text is overflowing and adjust size if needed
    function checkTextOverflow() {
      const subtitleWidth = subtitleElement.offsetWidth;
      const containerWidth = window.innerWidth * 0.9; // 90% of viewport width
      
      if (subtitleWidth > containerWidth) {
        // Get current font size and reduce it a bit
        const currentSize = parseFloat(getComputedStyle(subtitleElement).fontSize);
        subtitleElement.style.fontSize = (currentSize * 0.9) + 'px';
      }
    }
    
    // Check overflow on subtitle updates and window resize
    socket.on('subtitle-update', checkTextOverflow);
    window.addEventListener('resize', checkTextOverflow);
  </script>
</body>
</html>
`;

fs.writeFileSync(path.join(publicDir, 'subtitles.html'), subtitleHTML);

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // Send current status to newly connected client
  socket.emit('system-message', {
    text: 'Connected to voice server',
    time: Date.now()
  });
  
  // Send current subtitle state to newly connected client
  if (currentSubtitle) {
    socket.emit('subtitle-update', currentSubtitle);
  }
  
  // If a song is currently playing, send that state to the new client
  if (aiState.isSinging) {
    socket.emit('play-converted-song', {
      title: aiState.currentSongTitle || 'Now Playing',
      path: aiState.currentSongPath || ''
    });
  }
  
  // If a song is processing, send that state
  if (aiState.isProcessingSong) {
    socket.emit('song-update', {
      title: aiState.processingTitle || 'Processing song...',
      status: 'Processing...',
      progress: aiState.processingProgress || 50
    });
  }
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
  
  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

// Stream text response to all connected clients
async function streamTextResponse(text) {
  return new Promise((resolve) => {
    if (!text || text.length === 0) {
      console.warn('Empty text provided to streamTextResponse');
      io.emit('subtitle', { text: '', isComplete: true });
      return resolve();
    }
    
    console.log(`Streaming text response: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
    
    // Clean text - remove excess spaces, newlines, etc.
    const cleanedText = text
      .replace(/\s+/g, ' ')
      .trim();
    
    // If text is too long, we'll chunk it by sentences
    const maxChunkLength = 150;
    
    if (cleanedText.length <= maxChunkLength) {
      // Short text, send it all at once
      io.emit('subtitle', { 
        text: cleanedText,
        isComplete: true
      });
      resolve();
      return;
    }
    
    // Split into sentences for longer text
    // This regex splits on periods, question marks, and exclamation points
    // followed by a space or end of string
    const sentences = cleanedText.match(/[^.!?]+[.!?](?:\s|$)/g) || [cleanedText];
    
    // Combine sentences into reasonably-sized chunks
    const chunks = [];
    let currentChunk = '';
    
    for (const sentence of sentences) {
      if (currentChunk.length + sentence.length > maxChunkLength && currentChunk.length > 0) {
        // Current chunk would be too long, save it and start a new one
        chunks.push(currentChunk);
        currentChunk = sentence;
      } else {
        // Add to current chunk
        currentChunk += sentence;
      }
    }
    
    // Add the last chunk if not empty
    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }
    
    // Stream the chunks with delays
    let currentText = '';
    let chunkIndex = 0;
    
    function sendNextChunk() {
      if (chunkIndex >= chunks.length) {
        // All chunks sent
        io.emit('subtitle', { 
          text: currentText,
          isComplete: true
        });
        return resolve();
      }
      
      currentText += chunks[chunkIndex];
      
      io.emit('subtitle', { 
        text: currentText,
        isComplete: chunkIndex === chunks.length - 1
      });
      
      chunkIndex++;
      
      // Brief delay between chunks
      setTimeout(sendNextChunk, 300);
    }
    
    // Start streaming chunks
    sendNextChunk();
  });
}

// API endpoint for manual testing
app.post('/api/speak', async (req, res) => {
  try {
    const { message, username = 'Tester' } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }
    
    // Process the message asynchronously
    generateAIResponse(message, username)
      .then(response => {
        console.log(`Test API Response to ${username}: ${response}`);
      })
      .catch(error => {
        console.error('Error in test API:', error);
      });
    
    // Immediately return a success response
    res.json({ success: true, message: 'Processing started' });
  } catch (error) {
    console.error('API error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
(async () => {
  try {
    // Connect to MongoDB before starting the server
    await connectToMongoDB();
    
    // Initialize TTS
    tts = new ConsoleTTS();
    
    // Start the server
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Subtitles available at http://localhost:${PORT}/subtitles`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
})();

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nGracefully shutting down...');
  try {
    // Clean up TTS files
    const files = fs.readdirSync(AUDIO_CACHE_DIR);
    for (const file of files) {
      if (file.startsWith('tts_') && file.endsWith('.mp3')) {
        fs.unlinkSync(path.join(AUDIO_CACHE_DIR, file));
      }
    }
    
    // Close any active connections
    if (tts) {
      tts.close();
    }
    if (server) {
      server.close();
    }
    if (io) {
      io.close();
    }
    
    console.log('Cleanup complete. Goodbye!');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
});

// Function to process the next message in queue
async function processNextInQueue() {
  // Don't process if we're singing, processing a song, already speaking, or already processing a message from the queue
  if (aiState.isSinging || aiState.isProcessingSong || aiState.isSpeaking || aiState.isProcessingQueue) {
    return;
  }
  
  // Get the next message
  const nextMessage = aiState.messageQueue.shift();
  if (!nextMessage) {
    return;
  }
  
  // Set processing queue flag to true to prevent interruptions
  aiState.isProcessingQueue = true;
  
  try {
    console.log(`Processing queued message from ${nextMessage.username}`);
    await generateAIResponse(nextMessage.message, nextMessage.username);
  } catch (error) {
    console.error('Error processing queued message:', error);
  } finally {
    // Reset flag when done
    aiState.isProcessingQueue = false;
    
    // If there are more messages, process them after a short delay
    // This ensures we fully complete TTS before processing the next message
    if (aiState.messageQueue.length > 0) {
      setTimeout(processNextInQueue, 2000);
    }
  }
}

// Function to make AI talk on her own
async function generateAutoTalk() {
  // Don't auto-talk if we're busy, already speaking, or if auto-talk is disabled
  if (aiState.isSinging || (aiState.isProcessingSong && !aiState.processingTitle) || aiState.isSpeaking || !aiState.autoTalkEnabled) {
    scheduleNextAutoTalk();
    return;
  }
  
  // Check if chat has been active recently - don't interrupt if so
  const timeSinceChatActivity = Date.now() - aiState.lastChatActivity;
  if (timeSinceChatActivity < aiState.activeChatTimeout) {
    console.log('Chat recently active, delaying autotalk');
    scheduleNextAutoTalk();
    return;
  }
  
  // Only talk if it's been a while since the last time 
  const timeSinceLastSpoke = Date.now() - aiState.lastSpoke;
  if (timeSinceLastSpoke < 5000) { // Don't talk if spoken in the last 5 seconds
    scheduleNextAutoTalk();
    return;
  }
  
  console.log('Generating autonomous AI speech');
  
  // If processing a song, talk about that
  if (aiState.isProcessingSong && aiState.processingTitle) {
    await generateStallMessage(aiState.processingTitle);
    scheduleNextAutoTalk();
    return;
  }
  
  // Otherwise generate a random topic for the AI to talk about
  const topics = [
    "commenting on how quiet chat is",
    "complaining about money problems",
    "mentioning something about Abydos High School",
    "talking about her studies",
    "wondering if anyone is even listening",
    "sharing a random thought",
    "asking a rhetorical question to chat"
  ];
  
  const randomTopic = topics[Math.floor(Math.random() * topics.length)];
  await generateAIResponse(`The AI should start talking on her own about ${randomTopic}. Respond with only a single line.`, "System", true);
  
  // Schedule the next auto-talk
  scheduleNextAutoTalk();
}

// Function to schedule the next auto-talk
function scheduleNextAutoTalk() {
  if (!aiState.autoTalkEnabled) return;
  
  // Calculate random time with variance
  const variance = Math.floor(Math.random() * aiState.autoTalkVariance * 2) - aiState.autoTalkVariance;
  const nextTalkDelay = aiState.autoTalkInterval + variance;
  
  console.log(`Scheduled next auto-talk in ${Math.round(nextTalkDelay/1000)} seconds`);
  
  setTimeout(generateAutoTalk, nextTalkDelay);
}

// Generate stall messages while song is processing
async function generateStallMessage(songTitle) {
  // Only generate if we're processing a song and not already speaking
  // Also check if there's a pending song (ready to play) - don't stall if so
  if (!aiState.isProcessingSong || aiState.isSpeaking || aiState.pendingSong) {
    console.log(`Skipping stall message for "${songTitle}" - conditions not met`);
    return;
  }
  
  const timeSinceStart = Date.now() - aiState.songProcessingStartTime;
  
  // Different messages based on how long we've been waiting
  let context;
  if (timeSinceStart < 30000) { // First 30 seconds
    context = `You're excited about playing the song "${songTitle}" soon. Hype up chat while they wait for the song to process. Keep it brief.`;
  } else if (timeSinceStart < 60000) { // 30-60 seconds
    context = `The song "${songTitle}" is still processing. Reassure chat that it's coming soon and keep them entertained. Be impatient, but hype them up.`;
  } else { // Over a minute
    context = `The song "${songTitle}" is taking a while to process. Complain a bit about the wait but keep chat entertained. You're getting frustrated but trying to keep everyone excited.`;
  }
  
  // Log that we're sending a stall message to help with debugging
  console.log(`Sending stall message for "${songTitle}" - ${Math.round(timeSinceStart/1000)}s into processing`);
  
  await generateAIResponse(context, "System", true);
  
  // Schedule another stall message if we're still processing
  if (aiState.isProcessingSong && !aiState.pendingSong) {
    const nextDelay = Math.floor(Math.random() * 10000) + 15000; // 15-25 seconds
    // Clear any existing timer before setting a new one
    if (aiState.stallMessageTimer) {
      clearTimeout(aiState.stallMessageTimer);
    }
    aiState.stallMessageTimer = setTimeout(() => generateStallMessage(songTitle), nextDelay);
  }
}

// Initialize auto-talk system on startup
scheduleNextAutoTalk();
