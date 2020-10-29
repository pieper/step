class Slicer {
  // s = new Slicer()

  constructor(options={}) {
    this.url = options.url || 'http://localhost:2016/slicer';
  }

  request(endpoint, options={}) {
    return new Promise( (resolve, reject) => {
      let request = new XMLHttpRequest();
      request.responseType = options.responseType;
      request.onload = options.onload || function (event) {
        resolve(event.target.response);
      };
      request.onprogress = options.onprogress || function() {};
      request.onerror = options.onerror || function() {
        reject({
          status: request.status,
          statusText: request.statusText,
        });
      };
      let command = options.command || "GET";
      let url = `${this.url}/${endpoint}`;
      request.open(command, url, true);
      request.send(options.payload || null);
    });
  }

  volumes() {
    return this.request('volumes', {
      responseType: 'json'
    });
  }

  gridTransforms() {
    return this.request('gridTransforms', {
      responseType: 'json'
    });
  }

  postPixelFieldAsVolume(pixelField) {
    let nrrdArrayBuffer = NRRD.format(NRRD.pixelFieldToNRRD(pixelField));
    return new Promise( (resolve,reject) => {
      this.request(`volume?id=undefined`, {
        responseType: 'json',
        command: "POST",
        payload: nrrdArrayBuffer
      })
      .then(response => {
        resolve(response)
      })
      .catch(reject);
    });
  }

  volume(id) {
    return new Promise( (resolve,reject) => {
      this.request(`volume?id=${id}`, {
        responseType: 'arraybuffer'
      })
      .then(arrayBuffer => {
        let nrrd = NRRD.parse(arrayBuffer);
        resolve(NRRD.nrrdToDICOMDataset(nrrd));
      })
      .catch(reject);
    });
  }

  fiducials() {
    return new Promise( (resolve,reject) => {
      this.request(`fiducials`, {
        responseType: 'json'
      })
      .then(fiducials => {
        resolve(fiducials);
      })
      .catch(reject);
    });
  }

  gridTransform(id) {
    return new Promise( (resolve,reject) => {
      this.request(`gridTransform?id=${id}`, {
        responseType: 'arraybuffer',
        onprogress: (progressEvent) => {
          console.log(`${progressEvent.loaded} of ${progressEvent.total}`);
        }
      })
      .then(arrayBuffer => {
        console.log("arrayBuffer", arrayBuffer);
        let nrrd = NRRD.parse(arrayBuffer);
        resolve(NRRD.nrrdToDICOMDataset(nrrd));
      })
      .catch(reject);
    });
  }

  repl(code) {
    // p = s.repl("slicer.app.layoutManager().setLayout(slicer.vtkMRMLLayoutNode.SlicerLayoutOneUpRedSliceView)")
    return new Promise( (resolve,reject) => {
      this.request(`repl`, {
        responseType: 'json',
        command: 'POST',
        payload: code,
      })
      .then(json => {
        resolve(json);
      })
      .catch(reject);
    });
  }

}
