export interface SongLineToken {
  chord: string | null;
  lyric: string;
}

export interface SongLine {
  tokens: SongLineToken[];
  raw: string;
}

export interface SongSection {
  name: string;
  lines: SongLine[];
}

export interface SongData {
  id: string;
  title: string;
  key?: string;
  reviewed?: boolean;
  sections: SongSection[];
  sourcePath: string | null;
  source: string;
}

export interface SongIndexEntry {
  id: string;
  title: string;
  key?: string;
  reviewed?: boolean;
  sections: string[];
}
