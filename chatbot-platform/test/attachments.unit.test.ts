/** Tipos de archivo que se aceptan para automatizaciones: se decide por la firma del archivo, no por su nombre. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentAbsolutePath, identifyAttachment } from '../src/attachments.js';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer\n%%EOF\n');
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 0x20)]); // Office moderno y ZIP
const HTML = Buffer.from('<!doctype html><html><script>alert(1)</script></html>');
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]); // MZ: ejecutable de Windows
const OGG = Buffer.from('OggS\u0000\u0002' + 'x'.repeat(40), 'latin1');
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(16)]);
const MP3 = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.alloc(32)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32)]);
const CSV = Buffer.from('nombre,telefono\nAna,5215500000001\n');

test('archivos: el tipo real sale de la firma; la extensión solo distingue los formatos de Office', () => {
  assert.equal(identifyAttachment(PDF, 'cotizacion.pdf')?.mime, 'application/pdf');
  assert.equal(identifyAttachment(ZIP, 'lista.docx')?.mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(identifyAttachment(OGG, 'nota.ogg')?.kind, 'audio');
  assert.equal(identifyAttachment(MP3, 'audio.mp3')?.mime, 'audio/mpeg');
  assert.equal(identifyAttachment(MP4, 'video.mp4')?.kind, 'video');
  assert.equal(identifyAttachment(MP4, 'nota.m4a')?.mime, 'audio/mp4');
  assert.equal(identifyAttachment(WEBM, 'clip.webm')?.kind, 'video');
  assert.equal(identifyAttachment(CSV, 'contactos.csv')?.mime, 'text/csv');
});

test('archivos: se rechaza lo que no se manda a un cliente (HTML, ejecutables, comprimidos, Office con otra extensión)', () => {
  assert.equal(identifyAttachment(HTML, 'factura.pdf'), null, 'HTML con nombre de PDF');
  assert.equal(identifyAttachment(HTML, 'notas.txt'), null, 'HTML con nombre de texto');
  assert.equal(identifyAttachment(EXE, 'instalador.pdf'), null, 'ejecutable con nombre de PDF');
  assert.equal(identifyAttachment(ZIP, 'paquete.zip'), null, 'comprimido');
  assert.equal(identifyAttachment(ZIP, 'lista.docx.exe'), null, 'extensión ejecutable');
  assert.equal(identifyAttachment(ZIP, 'lista.xlsm'), null, 'hojas con macros no se aceptan');
  assert.equal(identifyAttachment(Buffer.from([0xff, 0x00, 0x01, 0x02]), 'datos.txt'), null, 'binario con extensión de texto');
});

test('archivos: la ruta de un archivo se queda dentro de la carpeta de subidas', () => {
  assert.throws(() => attachmentAbsolutePath('../../etc/passwd'), /no válida/);
  assert.ok(attachmentAbsolutePath('cuenta/attachments/a.pdf').endsWith('attachments/a.pdf'));
});
