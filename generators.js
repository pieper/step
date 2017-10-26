// populates Fields with data based on inputs
class Generator {  // TODO: unify with Space
  constructor(options={}) {
    this.useIntegerTextures = Generator.useIntegerTextures;
    this.gl = options.gl;
    this.uniforms = options.uniforms || {};
    this.inputFields = options.inputFields || [];
    this.outputFields = options.outputFields || [];
    this.program = undefined;

    // * for now, all PixelData in datasets is of type short
    // * pixel readback of float textures requires casting
    // * gl may allow read back of single component, but may only do rgba
    this.sliceViewArrayType = Int16Array;
    this.sliceViewBytesPerElement = 2;
    if (this.useIntegerTextures) {
      this.samplerType = "isampler3D";
      this.bufferType = "int";
      this.readPixelsFormat = this.gl.RED_INTEGER;
      this.readPixelsType = this.gl.SHORT;
      this.fallbackSliceViewsArrayType = Int32Array;
      this.fallbackNumberOfComponents = 4;
      this.fallbackReadPixelsFormat = this.gl.RGBA_INTEGER;
      this.fallbackReadPixelsType = this.gl.INT;
    } else {
      this.samplerType = "sampler3D";
      this.bufferType = "float";
      this.readPixelsFormat = this.gl.RED;
      this.readPixelsType = this.gl.FLOAT;
      this.fallbackSliceViewsArrayType = Float32Array;
      this.fallbackNumberOfComponents = 4;
      this.fallbackReadPixelsFormat = this.gl.RGBA;
      this.fallbackReadPixelsType = this.gl.FLOAT;
    }

    // TODO: need to consider rescaleIntercept/rescaleSlope when
    // writing out to image textures
  }

  // utility for printing multiline strings for debugging
  logWithLineNumbers(string) {
    let lineNumber = 1;
    string.split("\n").forEach(line=>{
      console.log(lineNumber, line);
      lineNumber += 1;
    });
  }

  // utility for printing human readable codes
  // TODO: could cache the mapping, but since this is only
  // for error messages performance is not critical
  static glConstantName(candidateValue) {
    let name;
    Object.entries(Generator.glConstants).forEach(entry => {
      let [key, value] = entry;
      if (candidateValue == value) {
        name = key;
      }
    });
    return name;
  }
}
Generator.useIntegerTextures = false; // default
// Generator.glConstants defined at bottom of file for readability

// Uses a GL program to generate fields
class ProgrammaticGenerator extends Generator {
  constructor(options={}) {
    super(options);
    let gl = this.gl;

    this.outputFields.forEach(outputField=>{
      outputField.generator = this;
    });

    // buffers for the textured plane in normalized (clip) space
    let renderImageVertices = [ -1., -1., 0.,
                                 1., -1., 0.,
                                -1.,  1., 0.,
                                 1.,  1., 0., ];
    this.renderImageCoordinatesBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.renderImageCoordinatesBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(renderImageVertices), gl.STATIC_DRAW);

    let renderImageTextureCoordinates = [ 0., 0.,
                                          1., 0.,
                                          0., 1.,
                                          1., 1. ];
    this.renderImageTexureCoordinatesBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.renderImageTexureCoordinatesBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(renderImageTextureCoordinates), gl.STATIC_DRAW);

    // framebuffer to attach texture layer for generating a slice
    this.framebuffer = gl.createFramebuffer();
  }

  headerSource() {
    return(`#version 300 es
      precision highp float;
      precision highp int;
      precision highp sampler3D;
      precision highp isampler3D;
    `);
  }

  _vertexShaderSource() {
    return (`${this.headerSource()}
      layout(location = 0) in vec3 coordinate;
      layout(location = 1) in vec2 textureCoordinate;
      uniform float slice;
      out vec3 interpolatedTextureCoordinate;
      void main()
      {
        interpolatedTextureCoordinate = vec3(textureCoordinate, slice);
        gl_Position = vec4(coordinate, 1.);
      }
    `);
  }

  _fragmentShaderSource() {
    return (`${this.headerSource()}
      // to be overridden by concrete subclass
    `);
  }

  updateProgram() {
    // recreate the program
    let gl = this.gl;
    if (this.program) {gl.deleteProgram(this.program);}

    this.vertexShaderSource = this._vertexShaderSource();
    this.fragmentShaderSource = this._fragmentShaderSource();

    // the program and shaders
    this.program = gl.createProgram();
    this.vertexShader = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(this.vertexShader, this.vertexShaderSource);
    gl.compileShader(this.vertexShader);
    if (!gl.getShaderParameter(this.vertexShader, gl.COMPILE_STATUS)) {
      this.logWithLineNumbers(this.vertexShaderSource);
      console.error('Could not compile vertexShader');
      console.log(gl.getShaderInfoLog(this.vertexShader));
      return;
    }
    this.fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(this.fragmentShader, this.fragmentShaderSource);
    gl.compileShader(this.fragmentShader);
    if (!gl.getShaderParameter(this.fragmentShader, gl.COMPILE_STATUS)) {
      this.logWithLineNumbers(this.fragmentShaderSource);
      console.error('Could not compile fragmentShader');
      console.log(gl.getShaderInfoLog(this.fragmentShader));
      return;
    }
    gl.attachShader(this.program, this.vertexShader);
    gl.deleteShader(this.vertexShader);
    gl.attachShader(this.program, this.fragmentShader);
    gl.deleteShader(this.fragmentShader);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      this.logWithLineNumbers(this.fragmentShaderSource);
      console.error('Could not link program');
      console.log(gl.getProgramInfoLog(this.program));
      return;
    }

    // activate the inputs
    this.inputFields.forEach(field => {
      if (field.needsUpdate()) {
        field.fieldToTexture(gl)
      }
    });
  }

  _setUniform(key, uniform) {
    let gl = this.gl;
    let location = gl.getUniformLocation(this.program, key);
    if (!location) {
      // for now, don't warn for this since the field superclass
      // declares visualization uniforms which may not be referenced
      // in generator code.  This could be a source of confusion
      // if uniforms aren't found in the shader code.
      // TODO: add a verbose mode for diagnostics and debugging
      //console.error('No uniform location for', key);
      return;
    }

    if (uniform.type == '3fv') {gl.uniform3fv(location, uniform.value); return;}
    if (uniform.type == '3iv') {gl.uniform3iv(location, uniform.value); return;}
    if (uniform.type == '4fv') {gl.uniform4fv(location, uniform.value); return;}
    if (uniform.type == '4iv') {gl.uniform4iv(location, uniform.value); return;}
    if (uniform.type == '1f') {gl.uniform1f(location, uniform.value); return;}
    if (uniform.type == '1ui') {gl.uniform1ui(location, uniform.value); return;}
    if (uniform.type == '1i') {gl.uniform1i(location, uniform.value); return;}
    if (uniform.type == 'Matrix3fv') {gl.uniformMatrix3fv(location, gl.FALSE, uniform.value); return;}
    if (uniform.type == 'Matrix4fv') {gl.uniformMatrix4fv(location, gl.FALSE, uniform.value); return;}
    console.error('Could not set uniform', key, uniform);
  }

  generate() {
    let gl = this.gl;
    let outputField0 = this.outputFields[0];

    gl.useProgram(this.program);

    gl.viewport(0, 0, outputField0.pixelDimensions[0], outputField0.pixelDimensions[1]);

    // the coordinate attribute
    gl.bindBuffer(gl.ARRAY_BUFFER, this.renderImageCoordinatesBuffer);
    let coordinateLocation = gl.getAttribLocation(this.program, "coordinate");
    gl.enableVertexAttribArray( coordinateLocation );
    gl.vertexAttribPointer( coordinateLocation, 3, gl.FLOAT, false, 0, 0);

    // the textureCoordinate attribute
    gl.bindBuffer(gl.ARRAY_BUFFER, this.renderImageTexureCoordinatesBuffer);
    let textureCoordinateLocation = gl.getAttribLocation(this.program, "textureCoordinate");
    gl.enableVertexAttribArray( textureCoordinateLocation );
    gl.vertexAttribPointer( textureCoordinateLocation, 2, gl.FLOAT, false, 0, 0);

    // the overall application uniforms, and the per-field uniforms
    Object.keys(this.uniforms).forEach(key=>{
      this._setUniform(key, this.uniforms[key]);
    });
    this.inputFields.forEach(field=>{
      let uniforms = field.uniforms();
      Object.keys(uniforms).forEach(key=>{
        this._setUniform(key, uniforms[key]);
      });
    });

    // activate any field textures
    let textureIndex = 0;
    this.inputFields.forEach(field=>{
      gl.activeTexture(gl.TEXTURE0+textureIndex);
      if (field.texture) {
        gl.bindTexture(gl.TEXTURE_3D, field.texture);
      }
      let textureSymbol = "inputTexture"+textureIndex;
      let samplerLocation = gl.getUniformLocation(this.program, textureSymbol);
      gl.uniform1i(samplerLocation, textureIndex);
      textureIndex++;
    });

    // generate the output by invoking the program once per slice
    let mipmapLevel = 0;
    let sliceUniformLocation = gl.getUniformLocation(this.program, "slice");
    let frames = outputField0.pixelDimensions[2];
    let fallbackSliceViews = {};
    for (let sliceIndex = 0; sliceIndex < frames; sliceIndex++) {
      let slice = (0.5 + sliceIndex) / frames;
      gl.uniform1f(sliceUniformLocation, slice);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      let drawBuffers = [];
      let attachment = 0;
      this.outputFields.forEach(outputField=>{
        gl.framebufferTextureLayer(gl.FRAMEBUFFER,
                                   gl.COLOR_ATTACHMENT0+attachment,
                                   outputField.texture,
                                   mipmapLevel, sliceIndex);
        drawBuffers.push(gl.COLOR_ATTACHMENT0+attachment);
        attachment++;
      });
      gl.drawBuffers(drawBuffers);
      let status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status != gl.FRAMEBUFFER_COMPLETE) {
        console.error("Incomplete framebuffer: " + Generator.glConstantName(status));
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      //
      // optional readback of rendered texture when generatedPixelData exists
      // - attempt to read native pixels, but fallback to rgba if needed
      //
      attachment = 0;
      this.outputFields.forEach(outputField=>{
        if (outputField.generatedPixelData) {
          let [w,h] = [outputField.dataset.Columns, outputField.dataset.Rows];
          let slicePixelCount = w * h;
          let sliceByteStart = sliceIndex * slicePixelCount * this.sliceViewBytesPerElement;
          let sliceView = new this.sliceViewArrayType(outputField.generatedPixelData,
                                          sliceByteStart, slicePixelCount);
          gl.readBuffer(gl.COLOR_ATTACHMENT0+attachment);
          let supportedFormat = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT);
          let supportedType = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE);
          if (supportedFormat != this.readPixelsFormat || supportedType != this.readPixelsType) {
            if (!fallbackSliceViews[attachment]) {
              console.log(`Framebuffer read not supported, using slower fallback method`);
              fallbackSliceViews[attachment] = new this.fallbackSliceViewsArrayType(
                                                this.fallbackNumberOfComponents * slicePixelCount);
            }
            let fallbackSliceView = fallbackSliceViews[attachment];
            gl.readPixels(0, 0, w, h,
              this.fallbackReadPixelsFormat, this.fallbackReadPixelsType, fallbackSliceView);
            for(let index = 0; index < slicePixelCount; ++index) {
              sliceView[index] = fallbackSliceView[this.fallbackNumberOfComponents*index];
            }
          } else {
            gl.readPixels(0, 0, w, h, this.readPixelsFormat, this.readPixelsType, sliceView);
          }
        }
        attachment++;
      });
    }
  }
}

// Uses a GL program to generate fields
class ExampleGenerator extends ProgrammaticGenerator {
  constructor(options={}) {
    super(options);
    this.uniforms.amplitude = { type: '1f', value: 1. };
    this.uniforms.frequency = { type: '1f', value: 1. };
  }

  _fragmentShaderSource() {
    return (`${this.headerSource()}

      ${function() {
          let textureDeclarations = '';
          this.inputFields.forEach(field=>{
            textureDeclarations += `uniform highp ${this.samplerType} textureUnit${field.id}`+";\n";
          });
          return(textureDeclarations);
        }.bind(this)()
      }

      in vec3 interpolatedTextureCoordinate;
      layout(location = 0) out ${this.bufferType} fragmentColor;
      layout(location = 1) out ${this.bufferType} altFragmentColor;

      uniform float slice;
      uniform float amplitude;
      uniform float frequency;
      uniform ${this.samplerType} inputTexture0;

      ${this.bufferType} sampleValue;
      ${this.bufferType} perturbation;

      // dummy example generator - makes darkened cones through volume
      void main()
      {
        perturbation = ${this.bufferType}(10. * amplitude * slice *
                          (sin(frequency*interpolatedTextureCoordinate.s)
                           + cos(frequency*interpolatedTextureCoordinate.t))
                        );
        vec3 tc = interpolatedTextureCoordinate;
        sampleValue = texture(inputTexture0, tc).r;
        fragmentColor = sampleValue + perturbation;
        altFragmentColor = sampleValue - perturbation;
      }
    `);
  }
}

// A base class for filters
class FilterGenerator extends ProgrammaticGenerator {
  // Set up pixelDimensions and textureToPixels
  constructor(options={}) {
    super(options);
    let u = this.uniforms
    let pixelDimensions = this.inputFields[0].pixelDimensions
    u['pixelDimensions'] = {type: '3iv', value: pixelDimensions};
    let pixelToTexture = pixelDimensions.map(e=>1./e);
    u['pixelToTexture'] = {type: '3fv', value: pixelToTexture};
  };

  headerSource() {
    return (`${super.headerSource()}
      const int sliceMode = 1; // used for texture sampling (get value not transfer function)
    `);
  }

}

Generator.glConstants = {
  ACTIVE_ATTRIBUTES : 35721,
  ACTIVE_TEXTURE : 34016,
  ACTIVE_UNIFORMS : 35718,
  ACTIVE_UNIFORM_BLOCKS : 35382,
  ALIASED_LINE_WIDTH_RANGE : 33902,
  ALIASED_POINT_SIZE_RANGE : 33901,
  ALPHA : 6406,
  ALPHA_BITS : 3413,
  ALREADY_SIGNALED : 37146,
  ALWAYS : 519,
  ANY_SAMPLES_PASSED : 35887,
  ANY_SAMPLES_PASSED_CONSERVATIVE : 36202,
  ARRAY_BUFFER : 34962,
  ARRAY_BUFFER_BINDING : 34964,
  ATTACHED_SHADERS : 35717,
  BACK : 1029,
  BLEND : 3042,
  BLEND_COLOR : 32773,
  BLEND_DST_ALPHA : 32970,
  BLEND_DST_RGB : 32968,
  BLEND_EQUATION : 32777,
  BLEND_EQUATION_ALPHA : 34877,
  BLEND_EQUATION_RGB : 32777,
  BLEND_SRC_ALPHA : 32971,
  BLEND_SRC_RGB : 32969,
  BLUE_BITS : 3412,
  BOOL : 35670,
  BOOL_VEC2 : 35671,
  BOOL_VEC3 : 35672,
  BOOL_VEC4 : 35673,
  BROWSER_DEFAULT_WEBGL : 37444,
  BUFFER_SIZE : 34660,
  BUFFER_USAGE : 34661,
  BYTE : 5120,
  CCW : 2305,
  CLAMP_TO_EDGE : 33071,
  COLOR : 6144,
  COLOR_ATTACHMENT0 : 36064,
  COLOR_ATTACHMENT1 : 36065,
  COLOR_ATTACHMENT2 : 36066,
  COLOR_ATTACHMENT3 : 36067,
  COLOR_ATTACHMENT4 : 36068,
  COLOR_ATTACHMENT5 : 36069,
  COLOR_ATTACHMENT6 : 36070,
  COLOR_ATTACHMENT7 : 36071,
  COLOR_ATTACHMENT8 : 36072,
  COLOR_ATTACHMENT9 : 36073,
  COLOR_ATTACHMENT10 : 36074,
  COLOR_ATTACHMENT11 : 36075,
  COLOR_ATTACHMENT12 : 36076,
  COLOR_ATTACHMENT13 : 36077,
  COLOR_ATTACHMENT14 : 36078,
  COLOR_ATTACHMENT15 : 36079,
  COLOR_BUFFER_BIT : 16384,
  COLOR_CLEAR_VALUE : 3106,
  COLOR_WRITEMASK : 3107,
  COMPARE_REF_TO_TEXTURE : 34894,
  COMPILE_STATUS : 35713,
  COMPRESSED_TEXTURE_FORMATS : 34467,
  CONDITION_SATISFIED : 37148,
  CONSTANT_ALPHA : 32771,
  CONSTANT_COLOR : 32769,
  CONTEXT_LOST_WEBGL : 37442,
  COPY_READ_BUFFER : 36662,
  COPY_READ_BUFFER_BINDING : 36662,
  COPY_WRITE_BUFFER : 36663,
  COPY_WRITE_BUFFER_BINDING : 36663,
  CULL_FACE : 2884,
  CULL_FACE_MODE : 2885,
  CURRENT_PROGRAM : 35725,
  CURRENT_QUERY : 34917,
  CURRENT_VERTEX_ATTRIB : 34342,
  CW : 2304,
  DECR : 7683,
  DECR_WRAP : 34056,
  DELETE_STATUS : 35712,
  DEPTH : 6145,
  DEPTH24_STENCIL8 : 35056,
  DEPTH32F_STENCIL8 : 36013,
  DEPTH_ATTACHMENT : 36096,
  DEPTH_BITS : 3414,
  DEPTH_BUFFER_BIT : 256,
  DEPTH_CLEAR_VALUE : 2931,
  DEPTH_COMPONENT : 6402,
  DEPTH_COMPONENT16 : 33189,
  DEPTH_COMPONENT24 : 33190,
  DEPTH_COMPONENT32F : 36012,
  DEPTH_FUNC : 2932,
  DEPTH_RANGE : 2928,
  DEPTH_STENCIL : 34041,
  DEPTH_STENCIL_ATTACHMENT : 33306,
  DEPTH_TEST : 2929,
  DEPTH_WRITEMASK : 2930,
  DITHER : 3024,
  DONT_CARE : 4352,
  DRAW_BUFFER0 : 34853,
  DRAW_BUFFER1 : 34854,
  DRAW_BUFFER2 : 34855,
  DRAW_BUFFER3 : 34856,
  DRAW_BUFFER4 : 34857,
  DRAW_BUFFER5 : 34858,
  DRAW_BUFFER6 : 34859,
  DRAW_BUFFER7 : 34860,
  DRAW_BUFFER8 : 34861,
  DRAW_BUFFER9 : 34862,
  DRAW_BUFFER10 : 34863,
  DRAW_BUFFER11 : 34864,
  DRAW_BUFFER12 : 34865,
  DRAW_BUFFER13 : 34866,
  DRAW_BUFFER14 : 34867,
  DRAW_BUFFER15 : 34868,
  DRAW_FRAMEBUFFER : 36009,
  DRAW_FRAMEBUFFER_BINDING : 36006,
  DST_ALPHA : 772,
  DST_COLOR : 774,
  DYNAMIC_COPY : 35050,
  DYNAMIC_DRAW : 35048,
  DYNAMIC_READ : 35049,
  ELEMENT_ARRAY_BUFFER : 34963,
  ELEMENT_ARRAY_BUFFER_BINDING : 34965,
  EQUAL : 514,
  FASTEST : 4353,
  FLOAT : 5126,
  FLOAT_32_UNSIGNED_INT_24_8_REV : 36269,
  FLOAT_MAT2 : 35674,
  FLOAT_MAT2x3 : 35685,
  FLOAT_MAT2x4 : 35686,
  FLOAT_MAT3 : 35675,
  FLOAT_MAT3x2 : 35687,
  FLOAT_MAT3x4 : 35688,
  FLOAT_MAT4 : 35676,
  FLOAT_MAT4x2 : 35689,
  FLOAT_MAT4x3 : 35690,
  FLOAT_VEC2 : 35664,
  FLOAT_VEC3 : 35665,
  FLOAT_VEC4 : 35666,
  FRAGMENT_SHADER : 35632,
  FRAGMENT_SHADER_DERIVATIVE_HINT : 35723,
  FRAMEBUFFER : 36160,
  FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE : 33301,
  FRAMEBUFFER_ATTACHMENT_BLUE_SIZE : 33300,
  FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING : 33296,
  FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE : 33297,
  FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE : 33302,
  FRAMEBUFFER_ATTACHMENT_GREEN_SIZE : 33299,
  FRAMEBUFFER_ATTACHMENT_OBJECT_NAME : 36049,
  FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE : 36048,
  FRAMEBUFFER_ATTACHMENT_RED_SIZE : 33298,
  FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE : 33303,
  FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE : 36051,
  FRAMEBUFFER_ATTACHMENT_TEXTURE_LAYER : 36052,
  FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL : 36050,
  FRAMEBUFFER_BINDING : 36006,
  FRAMEBUFFER_COMPLETE : 36053,
  FRAMEBUFFER_DEFAULT : 33304,
  FRAMEBUFFER_INCOMPLETE_ATTACHMENT : 36054,
  FRAMEBUFFER_INCOMPLETE_DIMENSIONS : 36057,
  FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT : 36055,
  FRAMEBUFFER_INCOMPLETE_MULTISAMPLE : 36182,
  FRAMEBUFFER_UNSUPPORTED : 36061,
  FRONT : 1028,
  FRONT_AND_BACK : 1032,
  FRONT_FACE : 2886,
  FUNC_ADD : 32774,
  FUNC_REVERSE_SUBTRACT : 32779,
  FUNC_SUBTRACT : 32778,
  GENERATE_MIPMAP_HINT : 33170,
  GEQUAL : 518,
  GREATER : 516,
  GREEN_BITS : 3411,
  HALF_FLOAT : 5131,
  HIGH_FLOAT : 36338,
  HIGH_INT : 36341,
  IMPLEMENTATION_COLOR_READ_FORMAT : 35739,
  IMPLEMENTATION_COLOR_READ_TYPE : 35738,
  INCR : 7682,
  INCR_WRAP : 34055,
  INT : 5124,
  INTERLEAVED_ATTRIBS : 35980,
  INT_2_10_10_10_REV : 36255,
  INT_SAMPLER_2D : 36298,
  INT_SAMPLER_2D_ARRAY : 36303,
  INT_SAMPLER_3D : 36299,
  INT_SAMPLER_CUBE : 36300,
  INT_VEC2 : 35667,
  INT_VEC3 : 35668,
  INT_VEC4 : 35669,
  INVALID_ENUM : 1280,
  INVALID_FRAMEBUFFER_OPERATION : 1286,
  INVALID_INDEX : 4294967295,
  INVALID_OPERATION : 1282,
  INVALID_VALUE : 1281,
  INVERT : 5386,
  KEEP : 7680,
  LEQUAL : 515,
  LESS : 513,
  LINEAR : 9729,
  LINEAR_MIPMAP_LINEAR : 9987,
  LINEAR_MIPMAP_NEAREST : 9985,
  LINES : 1,
  LINE_LOOP : 2,
  LINE_STRIP : 3,
  LINE_WIDTH : 2849,
  LINK_STATUS : 35714,
  LOW_FLOAT : 36336,
  LOW_INT : 36339,
  LUMINANCE : 6409,
  LUMINANCE_ALPHA : 6410,
  MAX : 32776,
  MAX_3D_TEXTURE_SIZE : 32883,
  MAX_ARRAY_TEXTURE_LAYERS : 35071,
  MAX_CLIENT_WAIT_TIMEOUT_WEBGL : 37447,
  MAX_COLOR_ATTACHMENTS : 36063,
  MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS : 35379,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS : 35661,
  MAX_COMBINED_UNIFORM_BLOCKS : 35374,
  MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS : 35377,
  MAX_CUBE_MAP_TEXTURE_SIZE : 34076,
  MAX_DRAW_BUFFERS : 34852,
  MAX_ELEMENTS_INDICES : 33001,
  MAX_ELEMENTS_VERTICES : 33000,
  MAX_ELEMENT_INDEX : 36203,
  MAX_FRAGMENT_INPUT_COMPONENTS : 37157,
  MAX_FRAGMENT_UNIFORM_BLOCKS : 35373,
  MAX_FRAGMENT_UNIFORM_COMPONENTS : 35657,
  MAX_FRAGMENT_UNIFORM_VECTORS : 36349,
  MAX_PROGRAM_TEXEL_OFFSET : 35077,
  MAX_RENDERBUFFER_SIZE : 34024,
  MAX_SAMPLES : 36183,
  MAX_SERVER_WAIT_TIMEOUT : 37137,
  MAX_TEXTURE_IMAGE_UNITS : 34930,
  MAX_TEXTURE_LOD_BIAS : 34045,
  MAX_TEXTURE_SIZE : 3379,
  MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS : 35978,
  MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS : 35979,
  MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS : 35968,
  MAX_UNIFORM_BLOCK_SIZE : 35376,
  MAX_UNIFORM_BUFFER_BINDINGS : 35375,
  MAX_VARYING_COMPONENTS : 35659,
  MAX_VARYING_VECTORS : 36348,
  MAX_VERTEX_ATTRIBS : 34921,
  MAX_VERTEX_OUTPUT_COMPONENTS : 37154,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS : 35660,
  MAX_VERTEX_UNIFORM_BLOCKS : 35371,
  MAX_VERTEX_UNIFORM_COMPONENTS : 35658,
  MAX_VERTEX_UNIFORM_VECTORS : 36347,
  MAX_VIEWPORT_DIMS : 3386,
  MEDIUM_FLOAT : 36337,
  MEDIUM_INT : 36340,
  MIN : 32775,
  MIN_PROGRAM_TEXEL_OFFSET : 35076,
  MIRRORED_REPEAT : 33648,
  NEAREST : 9728,
  NEAREST_MIPMAP_LINEAR : 9986,
  NEAREST_MIPMAP_NEAREST : 9984,
  NEVER : 512,
  NICEST : 4354,
  NONE : 0,
  NOTEQUAL : 517,
  NO_ERROR : 0,
  OBJECT_TYPE : 37138,
  ONE : 1,
  ONE_MINUS_CONSTANT_ALPHA : 32772,
  ONE_MINUS_CONSTANT_COLOR : 32770,
  ONE_MINUS_DST_ALPHA : 773,
  ONE_MINUS_DST_COLOR : 775,
  ONE_MINUS_SRC_ALPHA : 771,
  ONE_MINUS_SRC_COLOR : 769,
  OUT_OF_MEMORY : 1285,
  PACK_ALIGNMENT : 3333,
  PACK_ROW_LENGTH : 3330,
  PACK_SKIP_PIXELS : 3332,
  PACK_SKIP_ROWS : 3331,
  PIXEL_PACK_BUFFER : 35051,
  PIXEL_PACK_BUFFER_BINDING : 35053,
  PIXEL_UNPACK_BUFFER : 35052,
  PIXEL_UNPACK_BUFFER_BINDING : 35055,
  POINTS : 0,
  POLYGON_OFFSET_FACTOR : 32824,
  POLYGON_OFFSET_FILL : 32823,
  POLYGON_OFFSET_UNITS : 10752,
  QUERY_RESULT : 34918,
  QUERY_RESULT_AVAILABLE : 34919,
  R8 : 33321,
  R8I : 33329,
  R8UI : 33330,
  R8_SNORM : 36756,
  R11F_G11F_B10F : 35898,
  R16F : 33325,
  R16I : 33331,
  R16UI : 33332,
  R32F : 33326,
  R32I : 33333,
  R32UI : 33334,
  RASTERIZER_DISCARD : 35977,
  READ_BUFFER : 3074,
  READ_FRAMEBUFFER : 36008,
  READ_FRAMEBUFFER_BINDING : 36010,
  RED : 6403,
  RED_BITS : 3410,
  RED_INTEGER : 36244,
  RENDERBUFFER : 36161,
  RENDERBUFFER_ALPHA_SIZE : 36179,
  RENDERBUFFER_BINDING : 36007,
  RENDERBUFFER_BLUE_SIZE : 36178,
  RENDERBUFFER_DEPTH_SIZE : 36180,
  RENDERBUFFER_GREEN_SIZE : 36177,
  RENDERBUFFER_HEIGHT : 36163,
  RENDERBUFFER_INTERNAL_FORMAT : 36164,
  RENDERBUFFER_RED_SIZE : 36176,
  RENDERBUFFER_SAMPLES : 36011,
  RENDERBUFFER_STENCIL_SIZE : 36181,
  RENDERBUFFER_WIDTH : 36162,
  RENDERER : 7937,
  REPEAT : 10497,
  REPLACE : 7681,
  RG : 33319,
  RG8 : 33323,
  RG8I : 33335,
  RG8UI : 33336,
  RG8_SNORM : 36757,
  RG16F : 33327,
  RG16I : 33337,
  RG16UI : 33338,
  RG32F : 33328,
  RG32I : 33339,
  RG32UI : 33340,
  RGB : 6407,
  RGB5_A1 : 32855,
  RGB8 : 32849,
  RGB8I : 36239,
  RGB8UI : 36221,
  RGB8_SNORM : 36758,
  RGB9_E5 : 35901,
  RGB10_A2 : 32857,
  RGB10_A2UI : 36975,
  RGB16F : 34843,
  RGB16I : 36233,
  RGB16UI : 36215,
  RGB32F : 34837,
  RGB32I : 36227,
  RGB32UI : 36209,
  RGB565 : 36194,
  RGBA : 6408,
  RGBA4 : 32854,
  RGBA8 : 32856,
  RGBA8I : 36238,
  RGBA8UI : 36220,
  RGBA8_SNORM : 36759,
  RGBA16F : 34842,
  RGBA16I : 36232,
  RGBA16UI : 36214,
  RGBA32F : 34836,
  RGBA32I : 36226,
  RGBA32UI : 36208,
  RGBA_INTEGER : 36249,
  RGB_INTEGER : 36248,
  RG_INTEGER : 33320,
  SAMPLER_2D : 35678,
  SAMPLER_2D_ARRAY : 36289,
  SAMPLER_2D_ARRAY_SHADOW : 36292,
  SAMPLER_2D_SHADOW : 35682,
  SAMPLER_3D : 35679,
  SAMPLER_BINDING : 35097,
  SAMPLER_CUBE : 35680,
  SAMPLER_CUBE_SHADOW : 36293,
  SAMPLES : 32937,
  SAMPLE_ALPHA_TO_COVERAGE : 32926,
  SAMPLE_BUFFERS : 32936,
  SAMPLE_COVERAGE : 32928,
  SAMPLE_COVERAGE_INVERT : 32939,
  SAMPLE_COVERAGE_VALUE : 32938,
  SCISSOR_BOX : 3088,
  SCISSOR_TEST : 3089,
  SEPARATE_ATTRIBS : 35981,
  SHADER_TYPE : 35663,
  SHADING_LANGUAGE_VERSION : 35724,
  SHORT : 5122,
  SIGNALED : 37145,
  SIGNED_NORMALIZED : 36764,
  SRC_ALPHA : 770,
  SRC_ALPHA_SATURATE : 776,
  SRC_COLOR : 768,
  SRGB : 35904,
  SRGB8 : 35905,
  SRGB8_ALPHA8 : 35907,
  STATIC_COPY : 35046,
  STATIC_DRAW : 35044,
  STATIC_READ : 35045,
  STENCIL : 6146,
  STENCIL_ATTACHMENT : 36128,
  STENCIL_BACK_FAIL : 34817,
  STENCIL_BACK_FUNC : 34816,
  STENCIL_BACK_PASS_DEPTH_FAIL : 34818,
  STENCIL_BACK_PASS_DEPTH_PASS : 34819,
  STENCIL_BACK_REF : 36003,
  STENCIL_BACK_VALUE_MASK : 36004,
  STENCIL_BACK_WRITEMASK : 36005,
  STENCIL_BITS : 3415,
  STENCIL_BUFFER_BIT : 1024,
  STENCIL_CLEAR_VALUE : 2961,
  STENCIL_FAIL : 2964,
  STENCIL_FUNC : 2962,
  STENCIL_INDEX8 : 36168,
  STENCIL_PASS_DEPTH_FAIL : 2965,
  STENCIL_PASS_DEPTH_PASS : 2966,
  STENCIL_REF : 2967,
  STENCIL_TEST : 2960,
  STENCIL_VALUE_MASK : 2963,
  STENCIL_WRITEMASK : 2968,
  STREAM_COPY : 35042,
  STREAM_DRAW : 35040,
  STREAM_READ : 35041,
  SUBPIXEL_BITS : 3408,
  SYNC_CONDITION : 37139,
  SYNC_FENCE : 37142,
  SYNC_FLAGS : 37141,
  SYNC_FLUSH_COMMANDS_BIT : 1,
  SYNC_GPU_COMMANDS_COMPLETE : 37143,
  SYNC_STATUS : 37140,
  TEXTURE : 5890,
  TEXTURE0 : 33984,
  TEXTURE1 : 33985,
  TEXTURE2 : 33986,
  TEXTURE3 : 33987,
  TEXTURE4 : 33988,
  TEXTURE5 : 33989,
  TEXTURE6 : 33990,
  TEXTURE7 : 33991,
  TEXTURE8 : 33992,
  TEXTURE9 : 33993,
  TEXTURE10 : 33994,
  TEXTURE11 : 33995,
  TEXTURE12 : 33996,
  TEXTURE13 : 33997,
  TEXTURE14 : 33998,
  TEXTURE15 : 33999,
  TEXTURE16 : 34000,
  TEXTURE17 : 34001,
  TEXTURE18 : 34002,
  TEXTURE19 : 34003,
  TEXTURE20 : 34004,
  TEXTURE21 : 34005,
  TEXTURE22 : 34006,
  TEXTURE23 : 34007,
  TEXTURE24 : 34008,
  TEXTURE25 : 34009,
  TEXTURE26 : 34010,
  TEXTURE27 : 34011,
  TEXTURE28 : 34012,
  TEXTURE29 : 34013,
  TEXTURE30 : 34014,
  TEXTURE31 : 34015,
  TEXTURE_2D : 3553,
  TEXTURE_2D_ARRAY : 35866,
  TEXTURE_3D : 32879,
  TEXTURE_BASE_LEVEL : 33084,
  TEXTURE_BINDING_2D : 32873,
  TEXTURE_BINDING_2D_ARRAY : 35869,
  TEXTURE_BINDING_3D : 32874,
  TEXTURE_BINDING_CUBE_MAP : 34068,
  TEXTURE_COMPARE_FUNC : 34893,
  TEXTURE_COMPARE_MODE : 34892,
  TEXTURE_CUBE_MAP : 34067,
  TEXTURE_CUBE_MAP_NEGATIVE_X : 34070,
  TEXTURE_CUBE_MAP_NEGATIVE_Y : 34072,
  TEXTURE_CUBE_MAP_NEGATIVE_Z : 34074,
  TEXTURE_CUBE_MAP_POSITIVE_X : 34069,
  TEXTURE_CUBE_MAP_POSITIVE_Y : 34071,
  TEXTURE_CUBE_MAP_POSITIVE_Z : 34073,
  TEXTURE_IMMUTABLE_FORMAT : 37167,
  TEXTURE_IMMUTABLE_LEVELS : 33503,
  TEXTURE_MAG_FILTER : 10240,
  TEXTURE_MAX_LEVEL : 33085,
  TEXTURE_MAX_LOD : 33083,
  TEXTURE_MIN_FILTER : 10241,
  TEXTURE_MIN_LOD : 33082,
  TEXTURE_WRAP_R : 32882,
  TEXTURE_WRAP_S : 10242,
  TEXTURE_WRAP_T : 10243,
  TIMEOUT_EXPIRED : 37147,
  TIMEOUT_IGNORED : -1,
  TRANSFORM_FEEDBACK : 36386,
  TRANSFORM_FEEDBACK_ACTIVE : 36388,
  TRANSFORM_FEEDBACK_BINDING : 36389,
  TRANSFORM_FEEDBACK_BUFFER : 35982,
  TRANSFORM_FEEDBACK_BUFFER_BINDING : 35983,
  TRANSFORM_FEEDBACK_BUFFER_MODE : 35967,
  TRANSFORM_FEEDBACK_BUFFER_SIZE : 35973,
  TRANSFORM_FEEDBACK_BUFFER_START : 35972,
  TRANSFORM_FEEDBACK_PAUSED : 36387,
  TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN : 35976,
  TRANSFORM_FEEDBACK_VARYINGS : 35971,
  TRIANGLES : 4,
  TRIANGLE_FAN : 6,
  TRIANGLE_STRIP : 5,
  UNIFORM_ARRAY_STRIDE : 35388,
  UNIFORM_BLOCK_ACTIVE_UNIFORMS : 35394,
  UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES : 35395,
  UNIFORM_BLOCK_BINDING : 35391,
  UNIFORM_BLOCK_DATA_SIZE : 35392,
  UNIFORM_BLOCK_INDEX : 35386,
  UNIFORM_BLOCK_REFERENCED_BY_FRAGMENT_SHADER : 35398,
  UNIFORM_BLOCK_REFERENCED_BY_VERTEX_SHADER : 35396,
  UNIFORM_BUFFER : 35345,
  UNIFORM_BUFFER_BINDING : 35368,
  UNIFORM_BUFFER_OFFSET_ALIGNMENT : 35380,
  UNIFORM_BUFFER_SIZE : 35370,
  UNIFORM_BUFFER_START : 35369,
  UNIFORM_IS_ROW_MAJOR : 35390,
  UNIFORM_MATRIX_STRIDE : 35389,
  UNIFORM_OFFSET : 35387,
  UNIFORM_SIZE : 35384,
  UNIFORM_TYPE : 35383,
  UNPACK_ALIGNMENT : 3317,
  UNPACK_COLORSPACE_CONVERSION_WEBGL : 37443,
  UNPACK_FLIP_Y_WEBGL : 37440,
  UNPACK_IMAGE_HEIGHT : 32878,
  UNPACK_PREMULTIPLY_ALPHA_WEBGL : 37441,
  UNPACK_ROW_LENGTH : 3314,
  UNPACK_SKIP_IMAGES : 32877,
  UNPACK_SKIP_PIXELS : 3316,
  UNPACK_SKIP_ROWS : 3315,
  UNSIGNALED : 37144,
  UNSIGNED_BYTE : 5121,
  UNSIGNED_INT : 5125,
  UNSIGNED_INT_2_10_10_10_REV : 33640,
  UNSIGNED_INT_5_9_9_9_REV : 35902,
  UNSIGNED_INT_10F_11F_11F_REV : 35899,
  UNSIGNED_INT_24_8 : 34042,
  UNSIGNED_INT_SAMPLER_2D : 36306,
  UNSIGNED_INT_SAMPLER_2D_ARRAY : 36311,
  UNSIGNED_INT_SAMPLER_3D : 36307,
  UNSIGNED_INT_SAMPLER_CUBE : 36308,
  UNSIGNED_INT_VEC2 : 36294,
  UNSIGNED_INT_VEC3 : 36295,
  UNSIGNED_INT_VEC4 : 36296,
  UNSIGNED_NORMALIZED : 35863,
  UNSIGNED_SHORT : 5123,
  UNSIGNED_SHORT_4_4_4_4 : 32819,
  UNSIGNED_SHORT_5_5_5_1 : 32820,
  UNSIGNED_SHORT_5_6_5 : 33635,
  VALIDATE_STATUS : 35715,
  VENDOR : 7936,
  VERSION : 7938,
  VERTEX_ARRAY_BINDING : 34229,
  VERTEX_ATTRIB_ARRAY_BUFFER_BINDING : 34975,
  VERTEX_ATTRIB_ARRAY_DIVISOR : 35070,
  VERTEX_ATTRIB_ARRAY_ENABLED : 34338,
  VERTEX_ATTRIB_ARRAY_INTEGER : 35069,
  VERTEX_ATTRIB_ARRAY_NORMALIZED : 34922,
  VERTEX_ATTRIB_ARRAY_POINTER : 34373,
  VERTEX_ATTRIB_ARRAY_SIZE : 34339,
  VERTEX_ATTRIB_ARRAY_STRIDE : 34340,
  VERTEX_ATTRIB_ARRAY_TYPE : 34341,
  VERTEX_SHADER : 35633,
  VIEWPORT : 2978,
  WAIT_FAILED : 37149,
  ZERO : 0,
}
