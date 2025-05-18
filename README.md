# AI Sings and Speaks

An AI-powered virtual streamer that can chat with viewers, sing songs on request, and play sound effects. The virtual streamer uses a large language model for conversation, Fish Audio TTS for speech, and Replay for AI voice singing.

## Features

- 🗣️ Text-to-Speech using Fish Audio voices
- 🎵 AI singing with Replay voice conversion
- 💬 Natural conversation using GPT-4o or compatible model
- 🔊 Sound effect playback
- 🎬 OBS integration with subtitles and "Now Playing" widgets
- 📱 Twitch chat integration
- 🗃️ Message history with MongoDB
- ⚡ Auto-talk feature for spontaneous AI chatter

## Setup Requirements

### Prerequisites
- [Node.js](https://nodejs.org/) (version 18+ recommended)
- [MongoDB](https://www.mongodb.com/) (or a MongoDB connection URI)
- [Replay](https://www.weights.gg/replay) for AI singing voice conversion
- [Fish Audio](https://fishaudio.ai/) API key for text-to-speech

### Setup Instructions

1. **Clone the repository:**
   ```bash
   git clone https://github.com/yourusername/ai-sings-and-speaks.git
   cd ai-sings-and-speaks
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Create required directories:**
   The following directories will be created automatically when needed, but you can create them manually:
   ```bash
   mkdir -p audio-cache downloads models outputs song-cache sound-effects weights
   ```

4. **Set up configuration:**
   ```bash
   cp .env.example .env
   ```
   Edit the `.env` file and add your API keys and configuration.

5. **Install Replay for AI singing:**
   Download and install Replay from [weights.gg/replay](https://www.weights.gg/replay)

6. **Download voice models:**
   - Voice models for singing should be downloaded from [weights.gg](https://www.weights.gg/) or use your own
   - Place voice models in the `models` directory or configure a custom path in your `.env`

7. **Configure voice models:**
   - Update the `VOICE_MODEL_ID` in your `.env` file to match the name of your voice model

8. **Start the server:**
   ```bash
   npm start
   ```

## Directory Structure

- **audio-cache/**: Cached TTS audio files
- **downloads/**: Temporary song downloads
- **models/**: Voice models for singing
- **outputs/**: Output files from Replay
- **public/**: Web pages for OBS browser sources
- **song-cache/**: Cached converted songs
- **sound-effects/**: Custom sound effects (add .mp3 files here)
- **weights/**: Model weights (copy from Replay installation)

## Configuration Options

Edit the `.env` file to customize your setup:

### LLM Configuration
- `OPENAI_API_KEY`: Your OpenAI API key (or compatible API)
- `OPENAI_BASE_URL`: API endpoint URL
- `OPENAI_MODEL`: Model to use (e.g., "gpt-4o")

### TTS Configuration
- `FISHAUDIO_KEY`: Your Fish Audio API key
- `VOICE_ID`: Voice ID to use for TTS
- `FISH_AUDIO_MODEL`: TTS model version

### Singing Configuration
- `VOICE_MODEL_ID`: Voice model name for singing
- `SONG_API_URL`: URL of the Replay API (default: http://localhost:62362)

### Other Settings
- `MONGODB_URI`: MongoDB connection string
- `TWITCH_OAUTH_TOKEN`: Twitch OAuth token for chat integration
- `PORT`: Web server port (default: 3000)

## Usage

Once the server is running:

1. **View subtitles:** http://localhost:3000/subtitles
2. **Now playing widget:** http://localhost:3000/now-playing
3. **Test interface:** http://localhost:3000 (for testing without Twitch)

### OBS Integration

Add browser sources in OBS:
- Add `http://localhost:3000/subtitles` as a browser source for showing speech
- Add `http://localhost:3000/now-playing` to show currently playing songs

### Sound Effects

Add MP3 files to the `sound-effects` directory. They will be automatically detected and can be triggered with:
```
@sound("sound-name", "times")
```
where "times" is optional (defaults to playing once).

## Upcoming Features

- Support for additional TTS providers
- Voice model fine-tuning options
- More customization options
- Expanded widget collection

## Troubleshooting

- **Issues with TTS**: Check your FISHAUDIO_KEY and VOICE_ID settings
- **Singing problems**: Ensure Replay is running and properly configured
- **Missing voice models**: Download models from weights.gg and place in the models directory
- **MongoDB errors**: Verify your MongoDB connection string 