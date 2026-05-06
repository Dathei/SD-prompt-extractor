#!/usr/bin/env python3
import re
import os
import json
import argparse
import numpy as np
import ffmpeg
from PIL import Image
import piexif
import piexif.helper
from enum import Enum
from typing import List, Dict, Tuple, Optional, Union, Any


class MetadataOption(Enum):
    ALL = 0
    POSITIVE_PROMPT = 1
    NEGATIVE_PROMPT = 2
    STEPS = 3
    SAMPLER = 4
    CFG = 5
    SIZE = 6


def extract_image_metadata(image_path: str, filetype: str = 'png', verbose: bool = False
                           ) -> Optional[Tuple[str, str, str, str, str, str, str]]:
    """
    Extract metadata from png or jpg image file.

    Args:
        image_path: Path to the image file
        filetype: Type of image file ('png' or 'jpg')
        verbose: Whether to print verbose information

    Returns:
        A tuple of (parameters, positive, negative, steps, sampler, cfg, size)
        or None if metadata couldn't be extracted.
    """
    try:
        if filetype == 'png':
            with Image.open(image_path) as img:
                metadata = img.info
                parameters = metadata.get('parameters', '')
        elif filetype == 'jpg':
            img = piexif.load(image_path)
            try:
                parameters = piexif.helper.UserComment.load(img["Exif"][piexif.ExifIFD.UserComment])
            except KeyError:  # no exif data
                if verbose:
                    print(f"No metadata found for {image_path}")
                # return '', '', '', '', '', '', ''
                return None
        else:
            raise ValueError("Invalid image type")

        positive_end = parameters.find("Negative")
        positive = parameters[:positive_end].strip()

        negative_start = parameters.find("Negative prompt: ")
        negative_end = parameters.find("Steps")
        negative = parameters[negative_start:negative_end].strip()

        steps_start = parameters.find("Steps: ")
        steps_end = parameters.find(", Sampler")
        steps = parameters[steps_start:steps_end].strip()

        sampler_start = parameters.find(", Sampler: ")
        sampler_end = parameters.find(", CFG scale")
        sampler = parameters[sampler_start:sampler_end].strip()

        cfg_start = parameters.find(", CFG scale: ")
        cfg_end = parameters.find(", Seed")
        cfg = parameters[cfg_start:cfg_end].strip()

        size_start = parameters.find("Size: ")
        size_end = parameters.find(", Model hash")
        size = parameters[size_start:size_end].strip()

        return parameters, positive, negative, steps, sampler, cfg, size

    except Exception as e:
        return None

def extract_image_metadata_comfy(file_path: str, filetype: str = 'png', verbose: bool = False
                            ) -> Optional[Tuple[str, str, str, str, str, str, str]]:
    try:
        vid = ffmpeg.probe(file_path)
        print(vid['streams'])
    except Exception as e:
        print(f"Error: {e}")


def process_string(s: str) -> str:
    """
    Cleans up a string by removing unwanted characters and formatting to avoid wasting tokens

    Args:
        s: String to process

    Returns:
        Processed string
    """
    s = re.sub(r"<.*?>", "", s)  # remove lora tags
    s = re.sub(r"\(", "", s)  # remove opening parentheses
    s = re.sub(r":[^)]*", "", s)  # remove emphasis
    s = re.sub(r"\)", "", s)  # remove closing parentheses
    s = re.sub(r"\n", ", ", s)  # remove newlines
    s = re.sub(r"\s*,", ",", s)  # remove leading spaces before commas
    s = re.sub(r"(,)(\w)", r", \1", s)  # Add space after comma
    #s = re.sub(r",\s*,", ",", s)  # remove empty commas
    s = re.sub(r"\s+", " ", s)  # remove extra spaces
    return s.strip()


def get_datalist(
    root_dir: str,
    option: MetadataOption = MetadataOption.POSITIVE_PROMPT,
    process: bool = True,
    amount: Optional[int] = None,
    verbose: bool = False
) -> List[str]:
    """
    Selects a random sample of images and extracts their metadata.

    Args:
        root_dir: Root directory to search for images
        option: Metadata option to extract
            0 - all, 1 - positive prompt, 2 - negative prompt,
            3 - steps, 4 - sampler, 5 - cfg, 6 - size
        process: If true, apply regex clean up for positive or negative prompts
        amount: Amount of images to process, None for all
        verbose: Whether to print verbose information

    Returns:
        List of metadata strings
    """

    data = []
    all_dirs = [dirpath for dirpath, dirnames, filenames in os.walk(root_dir)]

    if amount is None:
        dirs_to_process = all_dirs
    else:
        remaining_dirs = all_dirs.copy()
        dirs_to_process = []

        # Get initial sample of directories to process
        sample_size = min(amount, len(remaining_dirs))
        for _ in range(sample_size):
            if not remaining_dirs:
                break

            idx = np.random.randint(0, len(remaining_dirs))
            selected_dir = remaining_dirs.pop(idx)
            dirs_to_process.append(selected_dir)

    i = 0
    while i < len(dirs_to_process):
        dir = dirs_to_process[i]
        successful_in_dir = False
        for file in os.listdir(dir):
            try:
                if verbose:
                    print(f"[{i + 1}/{len(dirs_to_process)}] Processing {dir}")

                if file.endswith('.png') and not file.endswith('_thumbnail.png'):
                    metadata_result = extract_image_metadata(os.path.join(dir, file), filetype='png', verbose=verbose)
                elif file.endswith('.jpg'):
                    metadata_result = extract_image_metadata(os.path.join(dir, file), filetype='jpg', verbose=verbose)
                else:
                    continue

                metadata = metadata_result[option.value]
                if not metadata:  # Skip empty metadata
                    continue

            except TypeError:
                continue

            if (option.value == 0 or option.value == 1 or option.value == 2) and process:  # process_string only for positive or negative prompt
                processed_metadata = process_string(metadata)
                if processed_metadata:  # Only add non-empty strings
                    if data and processed_metadata == data[-1]:
                        continue  # Skip duplicates
                    data.append(processed_metadata)
                    successful_in_dir = True
            else:
                data.append(metadata)
                successful_in_dir = True

            if amount is not None and len(data) >= amount:
                return data

        if not successful_in_dir and amount is not None:
            # Extracting metadata has failed for an image, try to find another directory that hasn't been used yet
            if remaining_dirs:
                idx = np.random.randint(0, len(remaining_dirs))
                new_dir = remaining_dirs.pop(idx)
                dirs_to_process.append(new_dir)
                if verbose:
                    print(f"Added new directory {new_dir} to compensate for unsuccessful processing")
        i += 1

    return data


def write_to_file(
    input_root: str,
    output_path: str,
    option: MetadataOption = MetadataOption.POSITIVE_PROMPT,
    process: bool = True,
    amount: Optional[int] = None,
    verbose: bool = False
) -> None:
    """
    Extract metadata and write to textfile

    Args:
        input_root: Root directory to search for images
        output_path: Path to write output to
        option: Metadata option to extract
        process: If true, apply regex clean up for positive or negative prompts
        amount: Amount of images to process, None for all
        verbose: Whether to print verbose information
    """
    data = get_datalist(input_root, option, process, amount, verbose=verbose)
    with open(output_path, 'w') as file:
        for line in data:
            if line:  # skips empty lines caused by filtering duplicates
                try:
                    file.write(line + "\n\n")
                except UnicodeEncodeError:
                    print(f"Error writing line: {line}")
    print(f"Data written to {output_path}")


def add_lora_as_tags(image_data: str, strip_version: bool = False) -> List[str]:
    """
    Extracts LoRA tags from metadata string, optionally stripping version info.

    Args:
        image_data: Image metadata containing LoRA tags
        strip_version: Whether to strip version information from LoRA tags

    Returns:
        List of LoRA tags
    """
    lora_tags = re.findall(r"<lora:(.+?):.*?>", image_data)
    if not lora_tags:
        return []

    lora_tags = ["lora: " + lora for lora in lora_tags if lora]  # prepend "lora: " to each tag
    version_pattern = r"(?:[_-][Vv]?|[Vv])?\d+(?:-\d+)?$"

    # print(f"Found lora tags: {lora_tags}")
    if strip_version:
        stripped_loras = []
        for lora in lora_tags:
            stripped_lora = re.sub(version_pattern, "", lora)
            # if lora != stripped_lora:
            #     print(f"{lora} -> {stripped_lora}")
            stripped_loras.append(stripped_lora)
        return stripped_loras
    return lora_tags


def add_metadata_to_json(
    root_dir: str,
    amount: Optional[int] = None,
    overwrite: bool = False,
    option: MetadataOption = MetadataOption.ALL,
    verbose: bool = False,
    add_lora_tags: bool = False,
    strip_version: bool = False
) -> None:
    """
    Adds parameters of images to Eagle's metadata json file

    Args:
        root_dir: Root directory to search for images
        amount: Amount of images to process, None for all
        overwrite: Overwrite existing annotations
        option: Metadata option to extract
            0 - all, 1 - positive prompt, 2 - negative prompt,
            3 - steps, 4 - sampler, 5 - cfg, 6 - size
        verbose: Whether to print verbose information
        add_lora_tags: Whether to add LoRA tags to the JSON
        strip_version: Whether to strip version information from LoRA tags
    """

    processed_count = 0

    for root, dirs, files in os.walk(root_dir):
        # sort by creation date, from newest to oldest
        dirs.sort(key=lambda d: os.path.getctime(os.path.join(root, d)), reverse=True)

        for file in files:
            try:
                if file.endswith('.png') and not file.endswith('_thumbnail.png'):
                    parameters = extract_image_metadata(os.path.join(root, file), filetype='png', verbose=verbose)[
                        option.value]
                elif file.endswith('.jpg'):
                    parameters = extract_image_metadata(os.path.join(root, file), filetype='jpg', verbose=verbose)[
                        option.value]
                else:
                    continue  # skip any other files
            except TypeError:
                # parameters is None if image has no metadata
                continue

            if parameters is None or parameters.strip() == "":
                continue

            json_path = os.path.join(root, 'metadata.json')
            update_json = False

            try:
                try:
                    with open(json_path, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                except UnicodeDecodeError:
                    # If utf-8 fails, try utf-8-sig
                    try:
                        with open(json_path, 'r', encoding='utf-8-sig') as f:
                            data = json.load(f)
                    except UnicodeDecodeError:
                        # try latin-1
                        with open(json_path, 'r', encoding='latin-1') as f:
                            data = json.load(f)

                if overwrite or not data.get('annotation'):  # overwrite or empty annotation
                    parameters = re.sub(r",(\w)", r", \1", parameters)  # Add space after comma
                    if parameters:
                        data['annotation'] = parameters
                        update_json = True
                else:   # TODO: remove, just for debugging
                    #print(f"Annontation not empty: {data.get('annotation')}")
                    pass

                if add_lora_tags:
                    added_tags = False
                    new_lora_tags = add_lora_as_tags(parameters, strip_version=strip_version)
                    existing_tags = data.get('tags', [])
                    existing_tags_set = set(existing_tags)
                    for tag in new_lora_tags:
                        if tag not in existing_tags_set:
                            existing_tags.append(tag)
                            existing_tags_set.add(tag)
                            added_tags = True
                    if added_tags:
                        data['tags'] = existing_tags
                        update_json = True

                if update_json:
                    with open(json_path, 'w', encoding='utf-8') as f:
                        json.dump(data, f, ensure_ascii=False)

            except FileNotFoundError:
                if verbose:
                    print("No metadata file found")
                continue
            except UnicodeDecodeError:
                if verbose:
                    print(f"Error decoding file {file}")
                continue
            except PermissionError:
                if verbose:
                    print(f"Error: Permission denied for {json_path}.")
                continue

            processed_count += 1

            if amount is not None:
                print_percent = amount * 0.1    # Print progress every 10%
                if processed_count % print_percent == 0:
                    print(f"Processed {processed_count}/{amount} images")
            else:
                if processed_count % 100 == 0:
                    print(f"Processed {processed_count} images")

            if amount is not None and processed_count >= amount:
                return


if __name__ == '__main__':
    #root = "D:\\AI\\StableDiffusion2.library\\images"
    # add_metadata_to_json(root,
    #                      amount=50,
    #                      overwrite=True,
    #                      option=MetadataOption.ALL,
    #                      verbose=True,
    #                      add_lora_tags=True,
    #                      strip_version=True)
    print(extract_image_metadata(image_path="D:\\AI\\StableDiffusion.library\\images\\MJA2ILUCKC64X.info\\ComfyUI_00007_.png", verbose=True))
# Example prompt:
"""
score_9, score_8_up, source_anime, unusual creature, concept art, creature, floating, concept art, creature, alien, moth, biomorphic glyphs, bioluminescent, ((metallic body)), almost human, crab pincers, low detail,

 <lora:Alien_Concept_Art:1> <lora:xl_more_art-full_v1:0.6>
Negative prompt: score_6, score_5, score_4, monochrome

Steps: 25, Sampler: Euler a, CFG scale: 5, Seed: 1529354297, Size: 832x1200, Model hash: 67ab2fd8ec, Model: ponyDiffusionV6XL_v6StartWithThisOne, VAE hash: 235745af8d, VAE: sdxl_vae.safetensors, Denoising strength: 0.4, Clip skip: 2, Hires upscale: 1.5, Hires steps: 14, Hires upscaler: 4x-UltraSharp, Lora hashes: "Alien_Concept_Art: fbfb35629d0a, xl_more_art-full_v1: fe3b4816be83", Emphasis: No norm, Version: f0.0.17v1.8.0rc-latest-276-g29be1da7
"""
