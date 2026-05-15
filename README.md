# Stable Diffusion Prompt Extractor for Eagle
A fast, robust metadata and prompt extractor for AI-generated images and videos.

Built primarily as an **Eagle Plugin** to automatically add prompt information to the annotation window.
This provides a quick preview of which prompts and settings worked and which didn't.
It supports **ComfyUI** and **A1111 WebUI** (and its forks like Forge, and Neo).

This tool extracts the exact generation parameters from any modern local model.

---

## Features

### Eagle Plugin (Auto-Tagger & UI)
* **Background Auto-Tagging:** Automatically detects newly imported images/videos in Eagle and applies the generation
prompt to the "Annotation" field.
* **LoRA Tagging:** Optionally extract LoRAs used in the generation and add them as Eagle Tags.
* **Version Stripping:** Clean up your tag list by automatically stripping version numbers from LoRAs
(e.g., `My_Lora_v2` and `My_Lora_v3` both become `lora: My_Lora`).
* **Manual Control UI:** Select any number of files inside Eagle and manually run the extractor.

### Command Line Interface (CLI)
* **Standalone Usage:** You can use the CLI script to parse directories or single files.
* **Prompt Exporter:** Export random prompts from your library into a `.txt` file.
Perfect for feeding your favorite styles into an LLM to generate new, unique prompt variations.


### Supported Formats
* **Image Formats:** `.png`, `.jpg`, `.jpeg` 
* **Video Formats:** `.mp4`, `.mkv`, `.webm`, `.mov`, `.avi`

---

## Installation (Eagle Plugin)
1. Go to the [Releases](../../releases) page of this repository.
2. Download the latest `.eagleplugin` file.
3. Open Eagle, and double click the downloaded `.eagleplugin` file to install it.
4. The background auto-tagger will start immediately! Click the plugin icon in the Eagle toolbar (or press P)
to access the manual batch-processing UI.

Or alternatively: Open the plugin center inside Eagle and search for `Stable Diffusion Prompt Extractor` and
install it from there.

## Installation (Python CLI Standalone)
```bash
git clone https://github.com/Dathei/SD-prompt-extractor.git
cd SD-prompt-extractor
pip install -r requirements.txt
```

## CLI Usage Guide
The CLI uses a modular sub-command system.

### 1. Manual Eagle Mode (`eagle` or `e`)
This allows you to easily extract metadata of thousands of files within your Eagle library with just one single command.
```bash
# Extract metadata from the latest 100 files without overwriting existing annotations
python prompt_extractor.py eagle --dir "D:\Eagle.library\images" -a 100 --add_lora_tags --strip_version
```
**Arguments:**
* `--dir`: The root folder to scan.
* `-a` / `--amount`: (Optional) How many files to extract. Leave blank for all. Files are sorted by creation date.
* `-o` / `--offset`: (Optional) How many files to skip before extracting. Leave blank to extract the latest files.
* `--overwrite`: (Optional) Adding this flag will overwrite any existing annotations.
* `--add_lora_tags`: (Optional) Adds LoRas as tags.
* `--strip_version`: (Optional) Attempts to strip version information from LoRa tags to avoid very similar tags.
* `-v` / `--verbose`: (Optional) Verbose output for debugging purposes.

### 2. File Export Mode (`file` or `f`)
Extract specific metadata (like just the Positive Prompts, or just the Generation Settings) from a library and save it to a `.txt` file.

```bash
# Export 50 random positive prompts from your library to a text file
python prompt_extractor.py file --dir "D:\Images\AI" --out "C:\prompts.txt" --option POSITIVE_PROMPT -a 50 -p
```
**Arguments:**
* `--dir`: The root folder to scan.
* `--out`: The `.txt` file to save to.
* `--option`: What to extract (`ALL`, `PROMPT`, `POSITIVE_PROMPT`, `NEGATIVE_PROMPT`, `PARAMETERS`, `STEPS`, `SAMPLER`,
`CFG`, `SEED`, `SIZE`, `MODEL`).
* `-a` / `--amount`: (Optional) How many random files to extract. Leave blank for all.
* `-p` / `--process`: (Optional) Cleans up brackets, weights, and trailing commas from the text.

## Building the Executable
If you modify the Python script and want to build the `.exe` for the Eagle plugin yourself:
1. `pip install pyinstaller`
2. `pyinstaller --onefile prompt_extractor.py`
3. Place the resulting `prompt_extractor.exe` inside the `dist/` folder of the plugin directory (if it's not there already).

## License
MIT License. Feel free to fork, modify, and improve!