// CPace (lib/remote/cpace.ts) against the published vectors of draft-irtf-cfrg-cpace-21: the string utilities
// (Appendix A.1.2, A.1.4, A.3.5) and CPACE-RISTR255-SHA512 (Appendix B.3: the generator, both messages, K, the
// initiator-responder ISK, scalar_mult, and the invalid points scalar_mult_vfy must refuse). Then the properties the
// enrollment relies on: a wrong password gives another key, a tag binds AD, a tampered share aborts.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as cpace from '../lib/remote/cpace.ts';

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const leScalar = (s: string) => hex(s); // the draft gives ya / yb little endian

test('CPace string utilities: prepend_len, lv_cat, transcript_ir (draft A.1.2, A.1.4, A.3.5)', () => {
  assert.equal(cpace.prependLen(Buffer.alloc(0)).toString('hex'), '00');
  assert.equal(cpace.prependLen(Buffer.from('1234')).toString('hex'), '0431323334');
  const r127 = Buffer.from([...Array(127).keys()]);
  assert.equal(cpace.prependLen(r127).toString('hex'), '7f' + r127.toString('hex'));
  const r128 = Buffer.from([...Array(128).keys()]);
  assert.equal(cpace.prependLen(r128).toString('hex'), '8001' + r128.toString('hex'));
  assert.equal(cpace.lvCat(Buffer.from('1234'), Buffer.from('5'), Buffer.alloc(0), Buffer.from('678')).toString('hex'), '043132333401350003363738');
  assert.equal(cpace.transcriptIr(Buffer.from('123'), Buffer.from('PartyA'), Buffer.from('234'), Buffer.from('PartyB')).toString('hex'),
    '03313233065061727479410332333406506172747942');
  assert.equal(cpace.transcriptIr(Buffer.from('3456'), Buffer.from('PartyA'), Buffer.from('2345'), Buffer.from('PartyB')).toString('hex'),
    '043334353606506172747941043233343506506172747942');
});

// draft-irtf-cfrg-cpace-21 Appendix B.3
const V = {
  PRS: Buffer.from('Password'),
  CI: hex('0b415f696e69746961746f720b425f726573706f6e646572'),
  sid: hex('7e4b4791d6a8ef019b936c79fb7f2c57'),
  genStr: hex(`11435061636552697374726574746f3235350850617373776f726464
    00000000000000000000000000000000000000000000000000000000
    00000000000000000000000000000000000000000000000000000000
    00000000000000000000000000000000000000000000000000000000
    00000000000000000000000000000000180b415f696e69746961746f
    720b425f726573706f6e646572107e4b4791d6a8ef019b936c79fb7f
    2c57`),
  g: '222b6b195fe84b1652badb6f6a3ae3d24341e7306967f0b8115b40d5698c7e56',
  ya: leScalar('da3d23700a9e5699258aef94dc060dfda5ebb61f02a5ea77fad53f4ff0976d08'),
  ADa: Buffer.from('ADa'),
  Ya: 'd6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0eec482b9157',
  yb: leScalar('d2316b454718c35362d83d69df6320f38578ed5984651435e2949762d900b80d'),
  ADb: Buffer.from('ADb'),
  Yb: '3ea7e0b19560d7c0b0f5734f63b955286dfa8232b5ebe63324e2d9e7433f7258',
  K: '80b69a8a76457ab6a4d7f887a4bf6b55a2f80ac19c333f917a05fc9887c8b40f',
  transcript: `20d6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0e
    ec482b915703414461203ea7e0b19560d7c0b0f5734f63b955286dfa
    8232b5ebe63324e2d9e7433f725803414462`,
  ISK: `b69effbf61b51d56401c0f65601abe428de8206feaaf0e32198896dc
    ae7b35cd2b38950a39dfd5d4a79164614c2984f7daa460b588c1e80c
    3fa2068af7900447`,
};

test('CPACE-RISTR255-SHA512 vectors (draft B.3.1-B.3.5): generator string and generator, Ya, Yb, K, ISK', () => {
  assert.deepEqual(cpace.generatorString(V.PRS, V.CI, V.sid), V.genStr);
  assert.equal(cpace.generatorString(V.PRS, V.CI, V.sid).length, 170);
  const g = cpace.calculateGenerator(V.PRS, V.CI, V.sid);
  assert.equal(Buffer.from(g.toBytes()).toString('hex'), V.g);
  assert.equal(cpace.scalarMult(V.ya, g).toString('hex'), V.Ya);
  assert.equal(cpace.scalarMult(V.yb, g).toString('hex'), V.Yb);
  assert.equal(cpace.scalarMultVfy(V.ya, hex(V.Yb))!.toString('hex'), V.K);
  assert.equal(cpace.scalarMultVfy(V.yb, hex(V.Ya))!.toString('hex'), V.K);
  assert.deepEqual(cpace.transcriptIr(hex(V.Ya), V.ADa, hex(V.Yb), V.ADb), hex(V.transcript));
  assert.deepEqual(cpace.isk(V.sid, hex(V.K), hex(V.transcript)), hex(V.ISK));

  // the same through the two roles
  const a = cpace.initiator({ prs: V.PRS, ci: V.CI, sid: V.sid, ad: V.ADa, y: V.ya });
  assert.equal(a.Y.toString('hex'), V.Ya);
  const b = cpace.responder({ prs: V.PRS, ci: V.CI, sid: V.sid, ad: V.ADb, Ya: a.Y, ADa: V.ADa, y: V.yb });
  assert.ok(b);
  assert.equal(b.Y.toString('hex'), V.Yb);
  assert.deepEqual(b.isk, hex(V.ISK));
  assert.deepEqual(a.finish(b.Y, V.ADb)!.isk, hex(V.ISK));
});

test('CPACE-RISTR255-SHA512 vectors (draft B.3.10, B.3.11): scalar_mult, and scalar_mult_vfy refuses a non-point and the neutral element', () => {
  const s = hex('7cd0e075fa7955ba52c02759a6c90dbbfc10e6d40aea8d283e407d88cf538a05');
  const X = hex('2c3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c');
  assert.equal(cpace.scalarMultVfy(s, X)!.toString('hex'), '7c13645fe790a468f62c39beb7388e541d8405d1ade69d1778c5fe3e7f6b600e');
  assert.equal(cpace.scalarMultVfy(s, hex('2b3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c')), null, 'Y_i1 does not decode');
  assert.equal(cpace.scalarMultVfy(s, Buffer.alloc(32)), null, 'Y_i2 is G.I');
  assert.equal(cpace.responder({ prs: V.PRS, ci: V.CI, sid: V.sid, ad: V.ADb, Ya: Buffer.alloc(32), ADa: V.ADa }), null, 'B aborts on G.I');
  const a = cpace.initiator({ prs: V.PRS, ci: V.CI, sid: V.sid, ad: V.ADa });
  assert.equal(a.finish(Buffer.alloc(32), V.ADb), null, 'A aborts on G.I');
  assert.equal(a.finish(Buffer.alloc(31), V.ADb), null, 'A aborts on a share that is not 32 bytes');
});

test('CPace with key confirmation: the right password agrees and the tags check; a wrong one, other AD, or another sid does not', () => {
  const ci = cpace.lvCat(Buffer.from('ci'));
  const sid = Buffer.from('0123456789abcdef');
  const run = (pwA: string, pwB: string, { adB = Buffer.from('b'), sidB = sid }: { adB?: Buffer; sidB?: Buffer } = {}) => {
    const a = cpace.initiator({ prs: Buffer.from(pwA), ci, sid, ad: Buffer.from('a') });
    const b = cpace.responder({ prs: Buffer.from(pwB), ci, sid: sidB, ad: adB, Ya: a.Y, ADa: Buffer.from('a') });
    assert.ok(b);
    const ka = a.finish(b.Y, adB);
    assert.ok(ka);
    const tb = cpace.tag(b.macKey, b.Y, adB);
    return { ok: cpace.equal(cpace.tag(ka.macKey, b.Y, adB), tb), same: cpace.equal(ka.isk, b.isk) };
  };
  assert.deepEqual(run('482913', '482913'), { ok: true, same: true });
  assert.deepEqual(run('482913', '482914'), { ok: false, same: false });
  assert.deepEqual(run('482913', '482913', { sidB: Buffer.from('fedcba9876543210') }), { ok: false, same: false });
  // the tag covers B's AD: the joiner checks the host's attested keys through it
  const a = cpace.initiator({ prs: Buffer.from('1'), ci, sid, ad: Buffer.from('a') });
  const b = cpace.responder({ prs: Buffer.from('1'), ci, sid, ad: Buffer.from('keys'), Ya: a.Y, ADa: Buffer.from('a') });
  assert.ok(b);
  const ka = a.finish(b.Y, Buffer.from('other keys'));
  assert.ok(ka);
  assert.ok(!cpace.equal(cpace.tag(ka.macKey, b.Y, Buffer.from('other keys')), cpace.tag(b.macKey, b.Y, Buffer.from('keys'))));
  assert.ok(cpace.sampleScalar() < cpace.ORDER);
});
