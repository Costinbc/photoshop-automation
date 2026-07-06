// ExtendScript helpers injected into Photopea before the operations that need
// them. Photopea speaks the Photoshop DOM (a subset), so these are Photoshop
// style. Kept minimal — only the helpers the client actually calls.
//
// Quirks these work around are documented in the memory file
// "photopea-headless-gotchas"; the important ones inline below.
export const PRELUDE = `
// Photopea bounds elements are obfuscated UnitValue objects exposing .value
// (typeof mis-reports them as "number"); doc.width/height are plain numbers.
function px(v){
  if (v && typeof v.value === "number") return v.value;
  return parseFloat(v);
}

// Depth-first search for a layer by exact name, descending into groups.
function findLayer(root, name){
  var layers = root.layers;
  for (var i = 0; i < layers.length; i++){
    var l = layers[i];
    if (l.name === name) return l;
    if (l.typename === "LayerSet"){
      var f = findLayer(l, name);
      if (f) return f;
    }
  }
  return null;
}

function setVisible(root, name, on){
  var l = findLayer(root, name);
  if (l) l.visible = on;
  return l;
}

function setText(root, name, value){
  var l = findLayer(root, name);
  if (!l) throw new Error("text layer not found: " + name);
  l.textItem.contents = value;
  return l;
}

// The most-recently-opened document. Merely touching another doc's layers can
// flip app.activeDocument in Photopea, so never assume active == the image.
function lastOpened(){ return app.documents[app.documents.length - 1]; }

// Copy image doc 'srcDoc' and paste it into 'targetDoc' as a new layer named
// 'layerName'. Returns the pasted layer. Closes srcDoc.
function pasteImageInto(srcDoc, targetDoc, layerName){
  app.activeDocument = srcDoc;
  srcDoc.selection.selectAll();
  srcDoc.selection.copy();
  app.activeDocument = targetDoc;
  var pasted = targetDoc.paste();
  pasted.name = layerName;
  srcDoc.close(SaveOptions.DONOTSAVECHANGES);
  return pasted;
}
`;
