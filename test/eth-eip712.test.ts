// SPDX-License-Identifier: Apache-2.0

import { create } from '@bufbuild/protobuf';
import { utf8ToBytes as utf8 } from '@noble/hashes/utils';
import { describe, expect, it } from 'vitest';
import {
  ETHTypedMessageValueResponseSchema,
  ETHTypedMessageValueResponse_RootObject as RootObject,
} from '../src/proto/gen/eth_pb.js';
import {
  DataType,
  buildStructTypes,
  encodeValue,
  getValue,
  parseEip712Message,
  parseType,
  type Eip712Message,
  type Eip712TypeMember,
} from '../src/internal/eth/eip712.js';

const EIP712_MSG: Eip712Message = {
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
    Attachment: [{ name: 'contents', type: 'string' }],
    Person: [
      { name: 'name', type: 'string' },
      { name: 'wallet', type: 'address' },
      { name: 'age', type: 'uint8' },
    ],
    Mail: [
      { name: 'from', type: 'Person' },
      { name: 'to', type: 'Person' },
      { name: 'contents', type: 'string' },
      { name: 'attachments', type: 'Attachment[]' },
    ],
  },
  primaryType: 'Mail',
  domain: {
    name: 'Ether Mail',
    version: '1',
    chainId: 1,
    verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
  },
  message: {
    from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826', age: 20 },
    to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB', age: '0x1e' },
    contents: 'Hello, Bob!',
    attachments: [{ contents: 'attachment1' }, { contents: 'attachment2' }],
  },
};

describe('parseType', () => {
  const empty: Record<string, Eip712TypeMember[]> = {};

  it('parses primitive types', () => {
    expect(parseType('string', empty).type).toBe(DataType.STRING);
    expect(parseType('bool', empty).type).toBe(DataType.BOOL);
    expect(parseType('address', empty).type).toBe(DataType.ADDRESS);
  });

  it('parses bytes and bytesN', () => {
    expect(parseType('bytes', empty)).toMatchObject({ type: DataType.BYTES, size: 0 });
    expect(parseType('bytes32', empty)).toMatchObject({ type: DataType.BYTES, size: 32 });
  });

  it('parses uintN/intN with size in bits → bytes', () => {
    expect(parseType('uint256', empty)).toMatchObject({ type: DataType.UINT, size: 32 });
    expect(parseType('int8', empty)).toMatchObject({ type: DataType.INT, size: 1 });
  });

  it('rejects unsized uint/int', () => {
    expect(() => parseType('uint', empty)).toThrow(
      expect.objectContaining({ code: 'eth-typed-message' }),
    );
    expect(() => parseType('int', empty)).toThrow(
      expect.objectContaining({ code: 'eth-typed-message' }),
    );
  });

  it('parses dynamic and fixed arrays', () => {
    const dyn = parseType('string[]', empty);
    expect(dyn.type).toBe(DataType.ARRAY);
    expect(dyn.size).toBe(0);
    expect(dyn.arrayType?.type).toBe(DataType.STRING);

    const fixed = parseType('string[521]', empty);
    expect(fixed.type).toBe(DataType.ARRAY);
    expect(fixed.size).toBe(521);
    expect(fixed.arrayType?.type).toBe(DataType.STRING);
  });

  it('parses multi-dimensional arrays', () => {
    const t = parseType('uint32[521][]', empty);
    expect(t.type).toBe(DataType.ARRAY);
    expect(t.size).toBe(0);
    expect(t.arrayType?.type).toBe(DataType.ARRAY);
    expect(t.arrayType?.size).toBe(521);
    expect(t.arrayType?.arrayType?.type).toBe(DataType.UINT);
    expect(t.arrayType?.arrayType?.size).toBe(4);
  });

  it('resolves struct names from the types table', () => {
    const t = parseType('Person', { Person: [] });
    expect(t.type).toBe(DataType.STRUCT);
    expect(t.structName).toBe('Person');
  });

  it('rejects unknown types', () => {
    expect(() => parseType('Unknown', empty)).toThrow(
      expect.objectContaining({ code: 'eth-typed-message' }),
    );
  });
});

describe('encodeValue', () => {
  const empty: Record<string, Eip712TypeMember[]> = {};

  it('encodes plain bytes as UTF-8', () => {
    expect(Array.from(encodeValue(parseType('bytes', empty), 'foo'))).toEqual(
      Array.from(utf8('foo')),
    );
  });

  it('decodes 0x-prefixed hex for bytesN', () => {
    expect(Array.from(encodeValue(parseType('bytes3', empty), '0xaabbcc'))).toEqual([
      0xaa,
      0xbb,
      0xcc,
    ]);
  });

  it('rejects punctuation in 0x-prefixed hex', () => {
    expect(() => encodeValue(parseType('bytes2', empty), '0x::')).toThrow(
      expect.objectContaining({ code: 'eth-typed-message' }),
    );
  });

  it('encodes uint64 from a JS number with no leading zeros', () => {
    expect(Array.from(encodeValue(parseType('uint64', empty), 2983742332))).toEqual([
      0xb1,
      0xd8,
      0x4b,
      0x7c,
    ]);
  });

  it('strips leading zeros from a 0x-hex uint string', () => {
    expect(Array.from(encodeValue(parseType('uint64', empty), '0x0001'))).toEqual([0x01]);
  });

  it('encodes int64 from a negative JS number with two\'s complement big-endian', () => {
    expect(Array.from(encodeValue(parseType('int64', empty), -2983742332))).toEqual([
      0xff,
      0x4e,
      0x27,
      0xb4,
      0x84,
    ]);
  });

  it.each([
    [0, '00'], [1, '01'], [-1, 'ff'],
    [127, '7f'], [128, '0080'], [129, '0081'],
    [-127, '81'], [-128, '80'], [-129, 'ff7f'],
    [255, '00ff'], [256, '0100'], [-255, 'ff01'], [-256, 'ff00'],
    [32767, '7fff'], [32768, '008000'],
    [-32768, '8000'], [-32769, 'ff7fff'],
    [65535, '00ffff'], [65536, '010000'],
  ] as const)('encodes signed %s consistently across input types', (value, expected) => {
    const typ = parseType('int64', empty);
    for (const input of [value, String(value), BigInt(value)]) {
      expect(Buffer.from(encodeValue(typ, input)).toString('hex')).toBe(expected);
    }
  });

  it('encodes booleans', () => {
    expect(Array.from(encodeValue(parseType('bool', empty), false))).toEqual([0]);
    expect(Array.from(encodeValue(parseType('bool', empty), true))).toEqual([1]);
  });

  it('encodes array length as 4-byte big-endian', () => {
    const t = parseType('uint8[]', empty);
    expect(Array.from(encodeValue(t, new Array(10).fill(1)))).toEqual([0x00, 0x00, 0x00, 0x0a]);
    expect(Array.from(encodeValue(t, new Array(1000).fill(1)))).toEqual([0x00, 0x00, 0x03, 0xe8]);
  });
});

describe('getValue', () => {
  function valueRequest(rootObject: RootObject, path: number[]) {
    return create(ETHTypedMessageValueResponseSchema, { rootObject, path });
  }

  it('returns domain.name', () => {
    const out = getValue(valueRequest(RootObject.DOMAIN, [0]), EIP712_MSG);
    expect(out.dataType).toBe(DataType.STRING);
    expect(Array.from(out.value)).toEqual(Array.from(utf8('Ether Mail')));
  });

  it('returns domain.chainId encoded as uint256(1) → [0x01]', () => {
    const out = getValue(valueRequest(RootObject.DOMAIN, [2]), EIP712_MSG);
    expect(out.dataType).toBe(DataType.UINT);
    expect(Array.from(out.value)).toEqual([0x01]);
  });

  it('returns message.from.name via nested struct path', () => {
    const out = getValue(valueRequest(RootObject.MESSAGE, [0, 0]), EIP712_MSG);
    expect(Array.from(out.value)).toEqual(Array.from(utf8('Cow')));
  });

  it('returns nested message.attachments[0].contents', () => {
    const out = getValue(valueRequest(RootObject.MESSAGE, [3, 0, 0]), EIP712_MSG);
    expect(Array.from(out.value)).toEqual(Array.from(utf8('attachment1')));
  });

  it('returns nested message.attachments[1].contents', () => {
    const out = getValue(valueRequest(RootObject.MESSAGE, [3, 1, 0]), EIP712_MSG);
    expect(Array.from(out.value)).toEqual(Array.from(utf8('attachment2')));
  });

  it('returns the array length when the path stops at an array', () => {
    const out = getValue(valueRequest(RootObject.MESSAGE, [3]), EIP712_MSG);
    expect(out.dataType).toBe(DataType.ARRAY);
    expect(Array.from(out.value)).toEqual([0x00, 0x00, 0x00, 0x02]);
  });

  it('rejects empty path on Domain (struct without leaf)', () => {
    expect(() => getValue(valueRequest(RootObject.DOMAIN, []), EIP712_MSG)).toThrow(
      expect.objectContaining({ code: 'eth-typed-message' }),
    );
  });

  it('rejects out-of-bounds array index', () => {
    expect(() => getValue(valueRequest(RootObject.MESSAGE, [3, 2, 0]), EIP712_MSG)).toThrow(
      expect.objectContaining({ code: 'eth-typed-message' }),
    );
  });

  it('rejects out-of-bounds struct member', () => {
    expect(() => getValue(valueRequest(RootObject.MESSAGE, [3, 1, 1]), EIP712_MSG)).toThrow(
      expect.objectContaining({ code: 'eth-typed-message' }),
    );
  });
});

describe('buildStructTypes', () => {
  it('produces protobuf StructTypes with parsed member types', () => {
    const out = buildStructTypes(EIP712_MSG.types);
    const mail = out.find((s) => s.name === 'Mail');
    expect(mail).toBeDefined();
    expect(mail!.members.map((m) => m.name)).toEqual(['from', 'to', 'contents', 'attachments']);
    const attachmentsMember = mail!.members[3];
    expect(attachmentsMember!.type?.type).toBe(DataType.ARRAY);
    expect(attachmentsMember!.type?.arrayType?.type).toBe(DataType.STRUCT);
    expect(attachmentsMember!.type?.arrayType?.structName).toBe('Attachment');
  });
});

describe('parseEip712Message', () => {
  it('parses and validates the full message shape', () => {
    expect(parseEip712Message(EIP712_MSG)).toEqual(EIP712_MSG);
  });

  it('rejects JSON strings; callers must pass the raw typed-data object', () => {
    expect(() => parseEip712Message(JSON.stringify(EIP712_MSG))).toThrow(
      expect.objectContaining({ code: 'eth-typed-message' }),
    );
  });

  it('rejects malformed type members', () => {
    expect(() =>
      parseEip712Message({
        ...EIP712_MSG,
        types: { EIP712Domain: [{ name: 'chainId' }] },
      }),
    ).toThrow(expect.objectContaining({ code: 'eth-typed-message' }));
  });

  it('rejects missing domain or message objects', () => {
    expect(() => parseEip712Message({ ...EIP712_MSG, domain: undefined })).toThrow(
      expect.objectContaining({ code: 'eth-typed-message' }),
    );
    expect(() => parseEip712Message({ ...EIP712_MSG, message: [] })).toThrow(
      expect.objectContaining({ code: 'eth-typed-message' }),
    );
  });
});
