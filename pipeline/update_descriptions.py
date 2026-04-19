import re

filepath = '/Users/alonsorobots/MyWork/RESEARCH/utopia/app/src/App.tsx'
with open(filepath, 'r') as f:
    content = f.read()

replacements = {
    'temp': "whoIsThisFor: 'People looking for a specific climate (e.g. escaping harsh winters or extreme heat).',",
    'tvar': "whoIsThisFor: 'People who want consistent year-round weather (low variation) vs distinct four seasons (high variation).',",
    'water': "whoIsThisFor: 'Farmers, off-grid homesteaders, or people who love lush green environments vs arid deserts.',",
    'solar': "whoIsThisFor: 'People looking to go off-grid with solar panels, or wanting a sunny climate to avoid seasonal affective disorder.',",
    'wind': "whoIsThisFor: 'Wind energy prospectors, kite surfers, or people looking to avoid constantly windy areas.',",
    'energy': "whoIsThisFor: 'People concerned about their carbon footprint, grid reliability, or national energy independence.',",
    'e_consume': "whoIsThisFor: 'Anyone wanting to understand the modernization and energy intensity of a lifestyle in a given area.',",
    'e_oil': "whoIsThisFor: 'Researchers or environmentalists tracking fossil fuel dependence.',",
    'e_coal': "whoIsThisFor: 'People tracking the dirtiest fossil fuels and related air quality impacts.',",
    'e_gas': "whoIsThisFor: 'Energy researchers monitoring transition fuels.',",
    'e_nuke': "whoIsThisFor: 'People concerned about nuclear proximity or supporting zero-carbon baseload energy.',",
    'e_hydro': "whoIsThisFor: 'Renewable energy advocates tracking large-scale geographical energy storage.',",
    'e_wind': "whoIsThisFor: 'Renewable energy advocates mapping the footprint of wind farms.',",
    'e_solar': "whoIsThisFor: 'Renewable energy advocates tracking grid-scale solar adoption.',",
    'e_geo': "whoIsThisFor: 'Specialized energy researchers tracking niche renewables.',",
    'agri': "whoIsThisFor: 'Homesteaders, farmers, and those seeking regional food security and local produce.',",
    'pop': "whoIsThisFor: 'People seeking vibrant, dense urban living vs those wanting remote, quiet rural isolation.',",
    'gdp': "whoIsThisFor: 'Anyone wanting to understand the true local economy and how wealthy the locals actually feel.',",
    'cost': "whoIsThisFor: 'Remote workers, expats, or retirees bringing outside money (like USD or pensions) who care about absolute costs.',",
    'air': "whoIsThisFor: 'People with asthma or children, and anyone wanting to avoid long-term health risks of pollution.',",
    'elev': "whoIsThisFor: 'Mountaineers, altitude-trainers, or people looking to avoid high altitude sickness.',",
    'risk': "whoIsThisFor: 'Homebuyers, insurers, or preppers wanting to avoid floods, earthquakes, and landslides.',",
    'inet': "whoIsThisFor: 'Digital nomads, remote workers, and gamers who rely on high-speed reliable connectivity.',",
    'depv': "whoIsThisFor: 'People seeking highly developed regions with excellent infrastructure, education, and health outcomes.',",
    'hcare': "whoIsThisFor: 'Retirees, people with medical conditions, or parents wanting quick access to hospitals.',",
    'free': "whoIsThisFor: 'Activists, journalists, and expats seeking civil liberties, political rights, and low corruption.',",
    'draw': "whoIsThisFor: 'You! Use this to manually select or exclude specific regions for your personal formula.',"
}

# Find AXES object
match = re.search(r'(const AXES:\s*Record<string,\s*AxisConfig>\s*=\s*\{)(.*?)(^\};\n\nconst)', content, re.DOTALL | re.MULTILINE)

if match:
    prefix = match.group(1)
    body = match.group(2)
    suffix = match.group(3)
    
    # For each key, find its description block and insert whoIsThisFor if not present
    for axis_id, who_text in replacements.items():
        # Regex to find description line within the block of this specific axis
        # We look for: axis_id: { ... description: '...', ... }
        # This is a bit tricky with regex, let's use a simpler approach.
        # Find `axis_id: {` and then the next `description: `
        pattern = r'(\n\s+' + axis_id + r':\s*\{.*?)(description:\s*\'[^\']*\'[^\n]*)'
        
        def replace_func(m):
            block_so_far = m.group(1)
            desc_line = m.group(2)
            indent = re.match(r'^(\s*)', desc_line).group(1) if re.match(r'^(\s*)', desc_line) else '    '
            # If whoIsThisFor is already there, skip
            if 'whoIsThisFor:' in block_so_far:
                return m.group(0)
            return f'{block_so_far}{desc_line}\n    {who_text}'
        
        body = re.sub(pattern, replace_func, body, count=1, flags=re.DOTALL)
    
    new_content = content[:match.start()] + prefix + body + suffix + content[match.end():]
    
    with open(filepath, 'w') as f:
        f.write(new_content)
    print("Updated App.tsx successfully.")
else:
    print("Could not find AXES.")

