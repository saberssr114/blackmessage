(function () {
  const versions = [
    { capacity: 17, data: 19, ecc: 7 },
    { capacity: 32, data: 34, ecc: 10 },
    { capacity: 53, data: 55, ecc: 15 },
    { capacity: 78, data: 80, ecc: 20 },
    { capacity: 106, data: 108, ecc: 26 }
  ];

  function appendBits(bits, value, length) {
    for (let index = length - 1; index >= 0; index -= 1) bits.push((value >>> index) & 1);
  }

  function multiply(a, b) {
    let result = 0;
    for (let index = 7; index >= 0; index -= 1) {
      result = (result << 1) ^ ((result >>> 7) * 0x11d);
      result ^= ((b >>> index) & 1) * a;
    }
    return result;
  }

  function divisor(degree) {
    const result = Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let index = 0; index < degree; index += 1) {
      for (let position = 0; position < degree; position += 1) {
        result[position] = multiply(result[position], root);
        if (position + 1 < degree) result[position] ^= result[position + 1];
      }
      root = multiply(root, 2);
    }
    return result;
  }

  function remainder(data, divisorBytes) {
    const result = Array(divisorBytes.length).fill(0);
    data.forEach(value => {
      const factor = value ^ result.shift();
      result.push(0);
      for (let index = 0; index < result.length; index += 1) {
        result[index] ^= multiply(divisorBytes[index], factor);
      }
    });
    return result;
  }

  function makeCodewords(bytes, version) {
    const config = versions[version - 1];
    if (bytes.length > config.capacity) throw new Error("Friend code is too long to create a QR code.");
    const bits = [];
    appendBits(bits, 4, 4);
    appendBits(bits, bytes.length, 8);
    bytes.forEach(byte => appendBits(bits, byte, 8));
    appendBits(bits, 0, Math.min(4, config.data * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let index = 0; index < bits.length; index += 8) {
      data.push(bits.slice(index, index + 8).reduce((value, bit) => (value << 1) | bit, 0));
    }
    for (let pad = 0; data.length < config.data; pad += 1) data.push(pad % 2 ? 0x11 : 0xec);
    return data.concat(remainder(data, divisor(config.ecc)));
  }

  function makeBase(version) {
    const size = version * 4 + 17;
    const modules = Array.from({ length: size }, () => Array(size).fill(false));
    const functions = Array.from({ length: size }, () => Array(size).fill(false));
    const setFunction = (x, y, value) => {
      if (x >= 0 && y >= 0 && x < size && y < size) {
        modules[y][x] = value;
        functions[y][x] = true;
      }
    };

    [[3, 3], [size - 4, 3], [3, size - 4]].forEach(([centerX, centerY]) => {
      for (let dy = -4; dy <= 4; dy += 1) {
        for (let dx = -4; dx <= 4; dx += 1) {
          const distance = Math.max(Math.abs(dx), Math.abs(dy));
          setFunction(centerX + dx, centerY + dy, distance !== 2 && distance !== 4);
        }
      }
    });

    for (let index = 8; index < size - 8; index += 1) {
      setFunction(6, index, index % 2 === 0);
      setFunction(index, 6, index % 2 === 0);
    }

    if (version > 1) {
      const centers = version === 2 ? [6, 18] : version === 3 ? [6, 22] : version === 4 ? [6, 26] : [6, 30];
      centers.forEach(centerY => centers.forEach(centerX => {
        if (functions[centerY][centerX]) return;
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            setFunction(centerX + dx, centerY + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }));
    }

    function drawFormat(mask) {
      const data = (1 << 3) | mask;
      let remainderBits = data;
      for (let index = 0; index < 10; index += 1) {
        remainderBits = (remainderBits << 1) ^ ((remainderBits >>> 9) * 0x537);
      }
      const format = ((data << 10) | remainderBits) ^ 0x5412;
      const bit = index => ((format >>> index) & 1) !== 0;
      for (let index = 0; index <= 5; index += 1) setFunction(8, index, bit(index));
      setFunction(8, 7, bit(6));
      setFunction(8, 8, bit(7));
      setFunction(7, 8, bit(8));
      for (let index = 9; index < 15; index += 1) setFunction(14 - index, 8, bit(index));
      for (let index = 0; index < 8; index += 1) setFunction(size - 1 - index, 8, bit(index));
      for (let index = 8; index < 15; index += 1) setFunction(8, size - 15 + index, bit(index));
      setFunction(8, size - 8, true);
    }
    drawFormat(0);
    return { modules, functions, size, setFunction, drawFormat };
  }

  function isMasked(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5: return (x * y) % 2 + (x * y) % 3 === 0;
      case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
      default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    }
  }

  function addData(base, codewords, mask) {
    const { modules, functions, size, drawFormat } = base;
    let bitIndex = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right -= 1;
      const upward = ((right + 1) & 2) === 0;
      for (let vertical = 0; vertical < size; vertical += 1) {
        const y = upward ? size - 1 - vertical : vertical;
        for (let offset = 0; offset < 2; offset += 1) {
          const x = right - offset;
          if (!functions[y][x]) {
            const value = bitIndex < codewords.length * 8
              ? ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0
              : false;
            modules[y][x] = value !== isMasked(mask, x, y);
            bitIndex += 1;
          }
        }
      }
    }
    drawFormat(mask);
    return modules;
  }

  function penalty(modules) {
    const size = modules.length;
    let score = 0;
    const lines = modules.concat(Array.from({ length: size }, (_, x) => modules.map(row => row[x])));
    lines.forEach(line => {
      let runColor = line[0];
      let runLength = 1;
      for (let index = 1; index < size; index += 1) {
        if (line[index] === runColor) {
          runLength += 1;
          if (runLength === 5) score += 3;
          else if (runLength > 5) score += 1;
        } else {
          runColor = line[index];
          runLength = 1;
        }
      }
      const values = line.map(value => value ? 1 : 0).join("");
      for (let index = 0; index <= size - 11; index += 1) {
        const slice = values.slice(index, index + 11);
        if (slice === "00001011101" || slice === "10111010000") score += 40;
      }
    });
    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const value = modules[y][x];
        if (modules[y][x + 1] === value && modules[y + 1][x] === value && modules[y + 1][x + 1] === value) score += 3;
      }
    }
    const darkCount = modules.reduce((count, row) => count + row.filter(Boolean).length, 0);
    score += Math.floor(Math.abs(darkCount * 100 / (size * size) - 50) / 5) * 10;
    return score;
  }

  function makeMatrix(value) {
    const bytes = Array.from(new TextEncoder().encode(value));
    const version = versions.findIndex(item => bytes.length <= item.capacity) + 1;
    if (!version) throw new Error("Friend code is too long to create a QR code.");
    const codewords = makeCodewords(bytes, version);
    let best = null;
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask += 1) {
      const base = makeBase(version);
      const candidate = addData(base, codewords, mask);
      const score = penalty(candidate);
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  }

  window.drawFriendQr = function (canvas, value) {
    const matrix = makeMatrix(value);
    const context = canvas.getContext("2d");
    const quietZone = 4;
    const scale = 6;
    const size = (matrix.length + quietZone * 2) * scale;
    canvas.width = size;
    canvas.height = size;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, size, size);
    context.fillStyle = "#000";
    matrix.forEach((row, y) => row.forEach((dark, x) => {
      if (dark) context.fillRect((x + quietZone) * scale, (y + quietZone) * scale, scale, scale);
    }));
    canvas.setAttribute("aria-label", "Friend QR code");
  };
})();
