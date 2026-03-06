from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import os
import subprocess
import re
import json

app = FastAPI()

# Allow CORS for frontend development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, replace with specific origin
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# Path to the songs directory (relative to this file)
BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SONGS_DIR = os.path.join(BASE_DIR, "songs")
FLAGGED_FILE = os.path.join(BASE_DIR, "backend", "flagged_songs.json")
DIST_DIR = os.path.join(BASE_DIR, "dist")

def rebuild_songs():
    # Only rebuild songs, no deployment
    try:
        # In production, rebuild to dist/data directly for instant updates
        env = os.environ.copy()
        if os.path.exists(DIST_DIR):
            env["SONGS_OUTPUT_DIR"] = os.path.join(DIST_DIR, "data")
        
        subprocess.run(["npm", "run", "build:songs"], cwd=BASE_DIR, check=True, env=env)
        print("Build script executed successfully.")
    except subprocess.CalledProcessError as e:
        print(f"Error during build: {e}")

def sanitize_filename(title: str) -> str:
    """Convert song title to a valid filename"""
    # Convert to lowercase and replace spaces with hyphens
    filename = title.lower().strip()
    # Remove special characters, keep only alphanumeric, hyphens, and spaces
    filename = re.sub(r'[^a-z0-9\s-]', '', filename)
    # Replace multiple spaces/hyphens with single hyphen
    filename = re.sub(r'[\s-]+', '-', filename)
    # Remove leading/trailing hyphens
    filename = filename.strip('-')
    return filename if filename else 'untitled-song'
class SongContent(BaseModel):
    content: str

class FlagRequest(BaseModel):
    song_id: str
    flagged: bool

class ReviewedRequest(BaseModel):
    song_id: str
    reviewed: bool

def load_flagged_songs():
    """Load flagged songs from file"""
    if os.path.exists(FLAGGED_FILE):
        with open(FLAGGED_FILE, 'r', encoding='utf-8') as f:
            return set(json.load(f))
    return set()

def save_flagged_songs(flagged_songs: set):
    """Save flagged songs to file"""
    with open(FLAGGED_FILE, 'w', encoding='utf-8') as f:
        json.dump(list(flagged_songs), f)

@app.get("/api/songs")
def list_songs():
    songs = []
    if os.path.exists(SONGS_DIR):
        for filename in os.listdir(SONGS_DIR):
            if filename.endswith(".pro"):
                songs.append(filename)
    return {"songs": sorted(songs)}

@app.post("/api/songs/create")
def create_song(song: SongContent, background_tasks: BackgroundTasks):
    """Create a new song file with auto-generated filename from title"""
    # Extract title from content
    title_match = re.search(r'\{title:\s*([^}]+)\}', song.content, re.IGNORECASE)
    if not title_match:
        raise HTTPException(status_code=400, detail="Song must have a {title: ...} directive")
    
    title = title_match.group(1).strip()
    base_filename = sanitize_filename(title)
    filename = f"{base_filename}.pro"
    filepath = os.path.join(SONGS_DIR, filename)
    
    # If file exists, add a number suffix
    counter = 1
    while os.path.exists(filepath):
        filename = f"{base_filename}-{counter}.pro"
        filepath = os.path.join(SONGS_DIR, filename)
        counter += 1
    
    # Ensure we are writing to the songs directory
    if os.path.commonpath([os.path.abspath(filepath), SONGS_DIR]) != SONGS_DIR:
        raise HTTPException(status_code=403, detail="Invalid file path")
    
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(song.content)
    
    # Trigger rebuild synchronously for instant updates
    rebuild_songs()
    
    # The ID is the base filename without extension
    song_id = os.path.splitext(filename)[0]
    
    return {"message": "Song created successfully", "filename": filename, "id": song_id}

@app.get("/api/songs/{filename}")
def get_song(filename: str):
    # Basic security check to prevent directory traversal
    if ".." in filename or "/" in filename or "\\" in filename:
         raise HTTPException(status_code=400, detail="Invalid filename")
    
    filepath = os.path.join(SONGS_DIR, filename)
    
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="Song not found")
    
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()
    
    return {"content": content}

@app.post("/api/songs/{filename}")
@app.put("/api/songs/{filename}")
def update_song(filename: str, song: SongContent, background_tasks: BackgroundTasks):
    """Update an existing song file"""
    # Basic security check to prevent directory traversal
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    
    filepath = os.path.join(SONGS_DIR, filename)
    
    # Ensure we are writing to the songs directory
    if os.path.commonpath([os.path.abspath(filepath), SONGS_DIR]) != SONGS_DIR:
        raise HTTPException(status_code=403, detail="Invalid file path")
    
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="Song not found")
    
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(song.content)
    
    # Trigger rebuild synchronously
    rebuild_songs()
    
    return {"message": "Song updated successfully", "filename": filename}

@app.delete("/api/songs/{filename}")
def delete_song(filename: str):
    """Delete a song file"""
    # Basic security check to prevent directory traversal
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    
    filepath = os.path.join(SONGS_DIR, filename)
    
    # Ensure we are deleting from the songs directory
    if os.path.commonpath([os.path.abspath(filepath), SONGS_DIR]) != SONGS_DIR:
        raise HTTPException(status_code=403, detail="Invalid file path")
    
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="Song not found")
    
    os.remove(filepath)
    
    # Trigger rebuild synchronously
    rebuild_songs()
    
    return {"message": "Song deleted successfully"}

@app.get("/api/flags")
def get_flagged_songs():
    """Get list of flagged song IDs"""
    flagged_songs = load_flagged_songs()
    return {"flagged": list(flagged_songs)}

@app.post("/api/flags")
def toggle_flag(request: FlagRequest):
    """Toggle flag status for a song"""
    flagged_songs = load_flagged_songs()
    
    if request.flagged:
        flagged_songs.add(request.song_id)
    else:
        flagged_songs.discard(request.song_id)
    
    save_flagged_songs(flagged_songs)
    return {"message": "Flag updated successfully", "flagged": list(flagged_songs)}

def find_song_file_by_id(song_id: str) -> str | None:
    """Find a .pro file by song ID (slug of title)"""
    if not os.path.exists(SONGS_DIR):
        return None
    
    for filename in os.listdir(SONGS_DIR):
        if not filename.endswith(".pro"):
            continue
        filepath = os.path.join(SONGS_DIR, filename)
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
        # Extract title and convert to slug
        title_match = re.search(r'\{title:\s*([^}]+)\}', content, re.IGNORECASE)
        if title_match:
            title = title_match.group(1).strip()
            # Create slug from title (same logic as frontend slugify)
            slug = re.sub(r'[^a-z0-9]+', '-', title.lower().strip())
            slug = re.sub(r'^-+|-+$', '', slug)
            if slug == song_id:
                return filepath
    return None

def update_reviewed_in_file(filepath: str, reviewed: bool) -> bool:
    """Update or add {reviewed: } directive in a .pro file"""
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()
    
    reviewed_value = "true" if reviewed else "false"
    
    # Check if {reviewed: } already exists
    if re.search(r'\{reviewed:\s*[^}]+\}', content, re.IGNORECASE):
        # Update existing
        new_content = re.sub(
            r'\{reviewed:\s*[^}]+\}',
            f'{{reviewed: {reviewed_value}}}',
            content,
            flags=re.IGNORECASE
        )
    else:
        # Add after {key: } or {title: }
        key_match = re.search(r'(\{key:\s*[^}]+\})', content, re.IGNORECASE)
        if key_match:
            # Add after key
            new_content = content.replace(
                key_match.group(1),
                f'{key_match.group(1)}\n{{reviewed: {reviewed_value}}}'
            )
        else:
            # Add after title
            title_match = re.search(r'(\{title:\s*[^}]+\})', content, re.IGNORECASE)
            if title_match:
                new_content = content.replace(
                    title_match.group(1),
                    f'{title_match.group(1)}\n{{reviewed: {reviewed_value}}}'
                )
            else:
                # Add at the beginning
                new_content = f'{{reviewed: {reviewed_value}}}\n{content}'
    
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(new_content)
    
    return True

@app.post("/api/reviewed")
def update_reviewed(request: ReviewedRequest, background_tasks: BackgroundTasks):
    """Update the reviewed status of a song in its .pro file"""
    filepath = find_song_file_by_id(request.song_id)
    
    if not filepath:
        raise HTTPException(status_code=404, detail=f"Song with ID '{request.song_id}' not found")
    
    try:
        update_reviewed_in_file(filepath, request.reviewed)
        # Trigger rebuild synchronously
        rebuild_songs()
        return {"success": True, "message": "Reviewed status updated", "reviewed": request.reviewed}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# Mount the static files from dist/ directory (production)
if os.path.exists(DIST_DIR):
    app.mount("/", StaticFiles(directory=DIST_DIR, html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

