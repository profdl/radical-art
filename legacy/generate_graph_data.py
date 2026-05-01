import os
import json
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse
from pathlib import Path

def normalize_path(path, base_path=None):
    # Remove query strings and fragments
    path = path.split('#')[0].split('?')[0]
    
    # Handle empty paths or paths that point to index
    if path in ['', 'index', 'index.html']:
        return 'index.html'
    
    # If we have a base path, resolve relative to it
    if base_path:
        # Get the directory of the base path
        base_dir = os.path.dirname(base_path)
        # Join with the current path and normalize
        path = os.path.normpath(os.path.join(base_dir, path))
        # Make relative to current directory
        path = os.path.relpath(path, '.')
    else:
        # Just normalize the path
        path = os.path.normpath(path.lstrip('./'))
    
    # If it's a directory path ending with /, append index.html
    if path.endswith('/') or os.path.isdir(path):
        path = os.path.join(path, 'index.html')
    
    # If no extension is provided and it's not a directory, append .html
    if not os.path.splitext(path)[1]:
        path = path + '.html'
    
    return path.replace('\\', '/')  # Ensure forward slashes for web paths

def is_local_link(href, base_path):
    if not href:
        return False
    parsed = urlparse(href)
    return (not parsed.netloc and 
            not href.startswith('mailto:') and 
            not href.startswith('#') and
            not href.startswith('javascript:'))

def get_links_from_file(file_path):
    # Try different encodings
    encodings = ['utf-8', 'latin1', 'cp1252', 'iso-8859-1']
    
    for encoding in encodings:
        try:
            with open(file_path, 'r', encoding=encoding) as f:
                content = f.read()
                soup = BeautifulSoup(content, 'html.parser')
                links = []
                
                for a in soup.find_all('a'):
                    href = a.get('href')
                    if href and is_local_link(href, file_path):
                        # Normalize the href relative to the current file
                        normalized_href = normalize_path(href, file_path)
                        links.append(normalized_href)
                
                return links
        except UnicodeDecodeError:
            continue
        except Exception as e:
            print(f"Error processing {file_path}: {str(e)}")
            return []
    
    print(f"Warning: Could not decode {file_path} with any supported encoding")
    return []

def generate_graph_data():
    nodes = []
    links = []
    node_ids = {}
    current_id = 0
    node_degrees = {}  # Track number of connections for each node
    
    # Walk through all directories
    for root, dirs, files in os.walk('.'):
        for file in files:
            if file.endswith('.html'):
                file_path = os.path.join(root, file)
                relative_path = os.path.relpath(file_path, '.')
                # Normalize the source path
                normalized_source = normalize_path(relative_path)
                
                # Add node if not exists
                if normalized_source not in node_ids:
                    node_ids[normalized_source] = current_id
                    nodes.append({
                        "id": current_id,
                        "name": normalized_source,
                        "degree": 0  # Initialize degree
                    })
                    current_id += 1
                
                # Get all links from the file
                file_links = get_links_from_file(file_path)
                
                for link in file_links:
                    # Add link target node if not exists
                    if link not in node_ids:
                        node_ids[link] = current_id
                        nodes.append({
                            "id": current_id,
                            "name": link,
                            "degree": 0  # Initialize degree
                        })
                        current_id += 1
                    
                    # Add link to graph
                    links.append({
                        "source": node_ids[normalized_source],
                        "target": node_ids[link]
                    })
                    
                    # Increment degrees for both source and target nodes
                    nodes[node_ids[normalized_source]]["degree"] += 1
                    nodes[node_ids[link]]["degree"] += 1
    
    # Calculate node sizes based on degrees
    max_degree = max(node["degree"] for node in nodes)
    min_size = 5  # Minimum node size
    max_size = 30  # Maximum node size
    
    for node in nodes:
        # Scale size based on degree, with a minimum size
        if max_degree > 0:  # Avoid division by zero
            normalized_degree = node["degree"] / max_degree
            node["size"] = min_size + (max_size - min_size) * normalized_degree
        else:
            node["size"] = min_size
    
    return {
        "nodes": nodes,
        "links": links
    }

if __name__ == "__main__":
    graph_data = generate_graph_data()
    
    # Save to JSON file
    with open('graph_data.json', 'w') as f:
        json.dump(graph_data, f, indent=2)
    
    print(f"Generated graph with {len(graph_data['nodes'])} nodes and {len(graph_data['links'])} links") 