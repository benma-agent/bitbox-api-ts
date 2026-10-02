// SPDX-License-Identifier: Apache-2.0

import { create } from '@bufbuild/protobuf';
import {
  ETHSignTypedMessageRequest_DataType as DataType,
  ETHSignTypedMessageRequest_MemberSchema,
  ETHSignTypedMessageRequest_MemberTypeSchema,
  ETHSignTypedMessageRequest_StructTypeSchema,
  ETHTypedMessageValueResponse_RootObject as RootObject,
  type ETHSignTypedMessageRequest_Member,
  type ETHSignTypedMessageRequest_MemberType,
  type ETHSignTypedMessageRequest_StructType,
  type ETHTypedMessageValueResponse,
} from '../../proto/gen/eth_pb.js';
import { ethTypedMessageError } from '../errors.js';
import {
  bigIntToSignedBytesBE,
  bigUintToBytesBE,
  hexToBytes,
  utf8ToBytes,
} from '../utils.js';

export { DataType };

export class TypedMessageError extends Error {
  readonly code = 'eth-typed-message';
  constructor(detail: string) {
    super(ethTypedMessageError(detail).message);
  }
}

export interface Eip712TypeMember {
  name: string;
  type: string;
}

export interface Eip712Message {
  types: Record<string, Eip712TypeMember[]>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseTypes(input: unknown): Record<string, Eip712TypeMember[]> {
  if (!isRecord(input)) {
    throw new TypedMessageError('Could not parse EIP-712 JSON message');
  }
  const types: Record<string, Eip712TypeMember[]> = {};
  for (const [name, members] of Object.entries(input)) {
    if (!Array.isArray(members)) {
      throw new TypedMessageError('Could not parse EIP-712 JSON message');
    }
    types[name] = members.map((member) => {
      if (!isRecord(member) || typeof member.name !== 'string' || typeof member.type !== 'string') {
        throw new TypedMessageError('Could not parse EIP-712 JSON message');
      }
      return { name: member.name, type: member.type };
    });
  }
  return types;
}

export function parseEip712Message(input: unknown): Eip712Message {
  if (!isRecord(input) || typeof input.primaryType !== 'string') {
    throw new TypedMessageError('Could not parse EIP-712 JSON message');
  }
  if (!isRecord(input.domain) || !isRecord(input.message)) {
    throw new TypedMessageError('Could not parse EIP-712 JSON message');
  }
  return {
    types: parseTypes(input.types),
    primaryType: input.primaryType,
    domain: input.domain,
    message: input.message,
  };
}

function makeMemberType(init: {
  type: DataType;
  size?: number;
  structName?: string;
  arrayType?: ETHSignTypedMessageRequest_MemberType;
}): ETHSignTypedMessageRequest_MemberType {
  return create(ETHSignTypedMessageRequest_MemberTypeSchema, {
    type: init.type,
    size: init.size ?? 0,
    structName: init.structName ?? '',
    ...(init.arrayType !== undefined ? { arrayType: init.arrayType } : {}),
  });
}

export function parseType(
  typ: string,
  types: Record<string, Eip712TypeMember[]>,
): ETHSignTypedMessageRequest_MemberType {
  if (typ.endsWith(']')) {
    const open = typ.lastIndexOf('[');
    if (open < 0) {
      throw new TypedMessageError(`Invalid type format: ${typ}`);
    }
    const inner = typ.slice(0, open);
    const sizeStr = typ.slice(open + 1, typ.length - 1);
    let size = 0;
    if (sizeStr !== '') {
      if (!/^\d+$/.test(sizeStr)) {
        throw new TypedMessageError(`Error parsing size: ${sizeStr}`);
      }
      size = Number(sizeStr);
    }
    return makeMemberType({
      type: DataType.ARRAY,
      size,
      arrayType: parseType(inner, types),
    });
  }
  if (typ.startsWith('bytes') && typ !== 'bytes') {
    const sizeStr = typ.slice('bytes'.length);
    if (!/^\d+$/.test(sizeStr)) {
      throw new TypedMessageError(`Error parsing size: ${sizeStr}`);
    }
    return makeMemberType({ type: DataType.BYTES, size: Number(sizeStr) });
  }
  if (typ === 'bytes') {
    return makeMemberType({ type: DataType.BYTES, size: 0 });
  }
  if (typ.startsWith('uint')) {
    const sizeStr = typ.slice('uint'.length);
    if (sizeStr === '') {
      throw new TypedMessageError('uint must be sized');
    }
    if (!/^\d+$/.test(sizeStr)) {
      throw new TypedMessageError(`Error parsing size: ${sizeStr}`);
    }
    return makeMemberType({ type: DataType.UINT, size: Number(sizeStr) / 8 });
  }
  if (typ.startsWith('int')) {
    const sizeStr = typ.slice('int'.length);
    if (sizeStr === '') {
      throw new TypedMessageError('int must be sized');
    }
    if (!/^\d+$/.test(sizeStr)) {
      throw new TypedMessageError(`Error parsing size: ${sizeStr}`);
    }
    return makeMemberType({ type: DataType.INT, size: Number(sizeStr) / 8 });
  }
  if (typ === 'bool') {
    return makeMemberType({ type: DataType.BOOL });
  }
  if (typ === 'address') {
    return makeMemberType({ type: DataType.ADDRESS });
  }
  if (typ === 'string') {
    return makeMemberType({ type: DataType.STRING });
  }
  if (Object.prototype.hasOwnProperty.call(types, typ)) {
    return makeMemberType({ type: DataType.STRUCT, structName: typ });
  }
  throw new TypedMessageError(`Can't recognize type: ${typ}`);
}

export function buildStructTypes(
  types: Record<string, Eip712TypeMember[]>,
): ETHSignTypedMessageRequest_StructType[] {
  return Object.entries(types).map(([name, members]) => {
    const protoMembers: ETHSignTypedMessageRequest_Member[] = members.map((member) =>
      create(ETHSignTypedMessageRequest_MemberSchema, {
        name: member.name,
        type: parseType(member.type, types),
      }),
    );
    return create(ETHSignTypedMessageRequest_StructTypeSchema, {
      name,
      members: protoMembers,
    });
  });
}

function decodeHex(s: string): Uint8Array {
  try {
    return hexToBytes(s.slice(2));
  } catch {
    throw new TypedMessageError(`invalid hex: ${s}`);
  }
}

function parseUintValue(value: unknown): bigint {
  if (typeof value === 'string') {
    if (value.startsWith('0x') || value.startsWith('0X')) {
      try {
        return BigInt(value);
      } catch {
        throw new TypedMessageError(`could not parse ${value} as hex`);
      }
    }
    if (!/^\d+$/.test(value)) {
      throw new TypedMessageError(`could not parse ${value} as uint`);
    }
    return BigInt(value);
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      throw new TypedMessageError('Number is not an uint');
    }
    return BigInt(value);
  }
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new TypedMessageError('Number is not an uint');
    }
    return value;
  }
  throw new TypedMessageError('Wrong type for uint');
}

function parseIntValue(value: unknown): bigint {
  if (typeof value === 'string') {
    if (!/^-?\d+$/.test(value)) {
      throw new TypedMessageError(`could not parse ${value} as int`);
    }
    return BigInt(value);
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new TypedMessageError('Number is not an int');
    }
    return BigInt(value);
  }
  if (typeof value === 'bigint') {
    return value;
  }
  throw new TypedMessageError('Wrong type for int');
}

export function encodeValue(
  typ: ETHSignTypedMessageRequest_MemberType,
  value: unknown,
): Uint8Array {
  switch (typ.type) {
    case DataType.BYTES: {
      if (typeof value !== 'string') {
        throw new TypedMessageError('Expected a string for bytes type');
      }
      if (value.startsWith('0x') || value.startsWith('0X')) {
        return decodeHex(value);
      }
      return utf8ToBytes(value);
    }
    case DataType.UINT: {
      const n = parseUintValue(value);
      return bigUintToBytesBE(n);
    }
    case DataType.INT: {
      const n = parseIntValue(value);
      return bigIntToSignedBytesBE(n);
    }
    case DataType.BOOL: {
      if (typeof value !== 'boolean') {
        throw new TypedMessageError('Expected a boolean value');
      }
      return new Uint8Array([value ? 1 : 0]);
    }
    case DataType.ADDRESS:
    case DataType.STRING: {
      if (typeof value !== 'string') {
        throw new TypedMessageError('Expected a string value');
      }
      return utf8ToBytes(value);
    }
    case DataType.ARRAY: {
      if (!Array.isArray(value)) {
        throw new TypedMessageError('Expected an array');
      }
      const len = value.length;
      const out = new Uint8Array(4);
      const view = new DataView(out.buffer);
      view.setUint32(0, len, false);
      return out;
    }
    default:
      throw new TypedMessageError('looked up value must not be a map or array');
  }
}

export function getValue(
  what: ETHTypedMessageValueResponse,
  msg: Eip712Message,
): { value: Uint8Array; dataType: DataType } {
  let currentValue: unknown;
  let currentType: ETHSignTypedMessageRequest_MemberType;
  switch (what.rootObject) {
    case RootObject.DOMAIN:
      currentValue = msg.domain;
      currentType = parseType('EIP712Domain', msg.types);
      break;
    case RootObject.MESSAGE:
      currentValue = msg.message;
      currentType = parseType(msg.primaryType, msg.types);
      break;
    default:
      throw new TypedMessageError('unknown root object');
  }

  for (const elementRaw of what.path) {
    const element = elementRaw;
    if (currentType.type === DataType.STRUCT) {
      const struct = msg.types[currentType.structName];
      if (struct === undefined) {
        throw new TypedMessageError(`could not lookup type of name: ${currentType.structName}`);
      }
      const member = struct[element];
      if (member === undefined) {
        throw new TypedMessageError(
          `could not lookup member #${element} of type: ${currentType.structName}`,
        );
      }
      if (typeof currentValue !== 'object' || currentValue === null) {
        throw new TypedMessageError('expected object value at struct position');
      }
      const obj = currentValue as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(obj, member.name)) {
        throw new TypedMessageError(`could not lookup: ${member.name}`);
      }
      currentValue = obj[member.name];
      currentType = parseType(member.type, msg.types);
    } else if (currentType.type === DataType.ARRAY) {
      if (!Array.isArray(currentValue)) {
        throw new TypedMessageError('expected array at array position');
      }
      if (element >= currentValue.length) {
        throw new TypedMessageError(`could not lookup array index: ${element}`);
      }
      currentValue = currentValue[element];
      if (currentType.arrayType === undefined) {
        throw new TypedMessageError('array type missing inner type');
      }
      currentType = currentType.arrayType;
    } else {
      throw new TypedMessageError('path element does not point to struct or array');
    }
  }

  if (
    currentType.type === DataType.STRUCT ||
    (currentType.type === DataType.ARRAY && !Array.isArray(currentValue))
  ) {
    throw new TypedMessageError('path points to struct or array; value expected');
  }

  return {
    value: encodeValue(currentType, currentValue),
    dataType: currentType.type,
  };
}
