import sys
from unittest.mock import MagicMock

# Mock dependencies before importing backend.main
mock_fastapi = MagicMock()
sys.modules["fastapi"] = mock_fastapi
sys.modules["fastapi.middleware.cors"] = MagicMock()
sys.modules["fastapi.staticfiles"] = MagicMock()
sys.modules["pydantic"] = MagicMock()

import pytest
import re
# Import the actual function
from backend.main import sanitize_filename

@pytest.mark.parametrize("input_title,expected_output", [
    ("Song Title", "song-title"),
    ("My SoNg", "my-song"),
    ("Song! @#$%^&*()Title", "song-title"),
    ("Song   Title", "song-title"),
    ("Song---Title", "song-title"),
    ("Song - - Title", "song-title"),
    ("  Song Title  ", "song-title"),
    ("--Song Title--", "song-title"),
    ("Song 123", "song-123"),
    ("", "untitled-song"),
    ("!!! @#$ %^&", "untitled-song"),
    (" - - ", "untitled-song"),
    ("123 abc", "123-abc"),
])
def test_sanitize_filename(input_title, expected_output):
    assert sanitize_filename(input_title) == expected_output
