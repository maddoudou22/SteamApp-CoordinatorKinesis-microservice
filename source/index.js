var AWS = require("aws-sdk");
const AWSXRay = require('aws-xray-sdk');
//var AWS = AWSXRay.captureAWS(require('aws-sdk'));

AWS.config.update({region: 'eu-west-1'});

exports.handler = (event, context, callback) => {
    
    // Récupération du Segment ID généré par X-ray pour ce segment pour pouvoir le transmettre dans le message SQS et assurer la traçabilité dans le service map de X-ray
	let segment = AWSXRay.getSegment();
	var xray_trace_id = segment.trace_id;

	// Création d'un Subsegment de X-ray pour tracer la récupération de la liste des applications :
    AWSXRay.captureFunc('recupListeApplications', function(subsegment){
		// Création d'annotations et de métédonnées pour apporter des infos plus détaillées dans les traces de X-ray :
        subsegment.addAnnotation('traceGlobale', `Evolution_Prix_Depuis_Lambda`);
        subsegment.addMetadata('metaGlobale', `Evolution_Prix_Depuis_Lambda`);
    
		const KinesisStream = process.env.KINESIS_STREAM_NAME; // Recuperation de l'URL du stream Kinesis dédié à la transmission d'ID d'applications Steam depuis les variables d'environnement
		const URLsteamApplicationList = process.env.APPLICATION_LIST_URL; // 'https://80q3vt1db6.execute-api.eu-west-1.amazonaws.com/Dev/SteamApplicationList-Workstation'; // Recuperation de l'URL de la fonction Lambda traitant la demande de liste d'application (via API Gateway) depuis les variables d'environnement

		// Récuperation de la liste des produits à vérifer :
		getSteamApplicationList(URLsteamApplicationList, function(responseFromTargetFunction){
			var  applicationList = responseFromTargetFunction;
			//console.log("Retour profile : " + applicationList.statusCode);
			//console.log("Taille : " + applicationList.body.listProduits.length);
			
			// La récupération de la liste des applications est terminée : fermeture du subsegment X-ray, sinon les informations le concernant ne sont pas envoyées à X-ray
			subsegment.close();

			// Parcours de chaque application de la liste récupérée :
			for (var i = 0, len = applicationList.body.listProduits.length; i < len; i++) {
				var IDproduit = applicationList.body.listProduits[i];
				console.log('ID du produit en cours danalyse : ' + IDproduit);
				
				// Envoie d'un message via Kinesis contenant l'ID du produit + l'ID de la trace X-ray pour préserver la traçabilité (car actuellement non gérée dans SQS) :
				requestProductPrice(IDproduit, KinesisStream, xray_trace_id, function(responseFromFunction){
					console.log('Verification envoyee pour le produit ' + IDproduit);
				});
			}
		}); // getSteamApplicationList()
 	}); // Subsegment XRAY
	
    callback(null, 'Finished');
};

// Fonction récupérant la liste des applications dans DynamoDB via un appel à une fonction Lambda via une API Gateway :
function getSteamApplicationList(URLsteamApplicationList, callback) {

    // Initialisation de 'https' avec X-Ray afin de remonter la trace de l'appel vers l'API distante :
    const https = AWSXRay.captureHTTPs(require('https'));

    // Appel de l'API :
    https.get(URLsteamApplicationList, (resp) => {
    
        let data = '';
        
        // A chunk of data has been recieved.
        resp.on('data', (chunk) => {
            data += chunk;
        });
    
        // The whole response has been received. Print out the result.
        resp.on('end', () => {
            //console.log('STATUS: ' + resp.statusCode);
            var receivedData = JSON.parse(data);
            callback (receivedData);
        });
    
    }).on("error", (err) => {
		console.log("Error: " + err.message);
    });
}

function requestProductPrice(IDproduit, kinesisStream, xray_trace_id, callback) {
    
    // Utilisation de X-Ray pour tracer l'appel vers Kinesis :
	// Création du client Kinesis :
    //const kinesis = new AWS.Kinesis({apiVersion: '2013-12-02'});
	const kinesis = AWSXRay.captureAWSClient(new AWS.Kinesis({apiVersion: '2013-12-02'}));
	
	// LE paragraphe suivant sert à 
		var xray_subsegment_id = '';
		xray_subsegment_temp = AWSXRay.getSegment();
		console.log("sqs XRAY : ", JSON.stringify(AWSXRay.getSegment()));
		console.log("xray_subsegment_temp : " + xray_subsegment_temp);
		try{
// Lors du premier appel de Kinesis, le 'subsegment' Kinesis automatiquement invoqué par X-Ray est toujours 'undefined' (bug X-Ray ?). D'où l'utilisation d'un 'try-catch' pour ne pas planter l'exécution de Lambda quand ça arrive.
			// Par contre les appel suivants (s'il y a plusieurs applications) arrivent bien à récupérer les infos du subsegment de Kinesis.
			// NOTE : ça implique que si la liste ne contient qu'une seule application, Kinesis et la fonction Lambda recevant le message ne sont jamais connectés dans le service map de X-ray !
			console.log("parse : " + xray_subsegment_temp.subsegments[xray_subsegment_temp.subsegments.length - 1].id);
			// 'xray_subsegment_id' sera récupéré par la fonction lambda recevant le message de SQS afin de l'utiliser comme 'Parent_ID' et assurer la traçabilité avec SQS dans le service map de X-ray :
			// Note qu'ici on utilise le dernier subsegment de la liste : pas très fiable pour la traçabilité, mais difficile de faire mieux tant que SQS n'est pas totalement compatible avec X-Ray 
			xray_subsegment_id = xray_subsegment_temp.subsegments[xray_subsegment_temp.subsegments.length - 1].id;
		}catch(e){
			// Systématiquement retourné lors du premier envoie de message via SQS (pour la première application - Produit) :
			console.log('xray_subsegment_temp.subsegments[0].id is undefined'); 
		}	

    var recordData = [];
    //var kinesisStream = 'kineTestLambda';

    // Création du message à pousser dans le stream :
    var record = {
        Data: JSON.stringify({
            'ID_PRODUIT' : IDproduit,
			'xray_trace_id' : xray_trace_id,
			'xray_id' : xray_subsegment_id
        }),
        PartitionKey: 'partition-1'
    };
    recordData.push(record);

    // Envoie du message dans le stream :
    kinesis.putRecords({
        Records: recordData,
        StreamName: kinesisStream
    }, function(err, data) {
        if (err) {
            console.error(err);
        }
        else {
            console.log('Message envoyé au stream : ', recordData);
            callback (recordData);
        }
    });
}
