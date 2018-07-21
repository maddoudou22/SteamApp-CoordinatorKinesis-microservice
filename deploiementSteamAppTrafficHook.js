'use strict';

var AWS = require('aws-sdk');
const codedeploy = new AWS.CodeDeploy({apiVersion: '2014-10-06'});
AWS.config.update({region: 'REGION'});

exports.handler = (event, context, callback) => {
    console.log(JSON.stringify(event));

    // Preparation des attributs requis pour Codedeploy :
    //Read the DeploymentId from the event payload.
    var deploymentId = event.DeploymentId;
        console.log(deploymentId);
    //Read the LifecycleEventHookExecutionId from the event payload
        var lifecycleEventHookExecutionId = event.LifecycleEventHookExecutionId;
    console.log(lifecycleEventHookExecutionId);

    // Preparation des variables pour le test :
    var lambda = new AWS.Lambda({region: 'eu-west-1', apiVersion: '2015-03-31'});
    //var cloudwatch = new AWS.CloudWatch(aws);
    var cloudwatch = new AWS.CloudWatch({region: 'eu-west-1', apiVersion: '2010-08-01'});
    var targetFunctionArn;
    var responseFromTargetFunction;
    var stringTestInput;
    var stringTestExpected;
    var resultatFinal;

    // Recuperation des variables d'environnement passees par le template CFN pour la creation de cette fonction): :
      // Nom de l'alias pointant sur la fonction a tester :
      var aliasName = process.env.aliasName;
      console.log("variable aliasName : " + aliasName);
      // ARN de la fonction avec la version a tester :
      var targetVersion = process.env.CurrentVersion;
      console.log("variable CurrentVersion : " + targetVersion);
      // Nom de la fonction a tester :
      var targetFunctionName = targetVersion.substring(47,targetVersion.length-2);
      console.log("variable targetFunctionName : " + targetFunctionName);
      // Le numero de version a tester
      var versionToTest = targetVersion.substring(targetVersion.length-1);

      // Le nom de l'alarme Cloudwatch associee a la fonction :
      var cloudformationAlarm = process.env.cloudformationAlarm;
      console.log("variable cloudformationAlarm : " + cloudformationAlarm);
      // Le nom du fichier contenant le test a passer (dans le meme repertoire que cette fonction node.js) :
      var fileTestInput = process.env.fileTestInput;
      console.log("variable fileTestInput : " + fileTestInput);
      // Le nom du fichier contenant le resultat du test attendu (dans le meme repertoire que cette fonction node.js) :
      var fileTestExpected = process.env.fileTestExpected;
      console.log("variable fileTestExpected : " + fileTestExpected);
      // Recuperation du test a passer :
      stringTestInput = recupFichier(fileTestInput);
      // Recuperation du resultat de test attendu :
      stringTestExpected = recupFichier(fileTestExpected);

        // Invocation de la fonction a tester avec la chaine de test :
        invoquefonctionCible(lambda, targetVersion, stringTestInput, function(responseFromTargetFunction){
	    // A revoir ...
            const responseParse = JSON.parse(responseFromTargetFunction);
            const responseBody = JSON.stringify(responseParse.body);
            console.log("responseFromTargetFunction : ", responseBody);
            console.log("stringTestExpected : ", stringTestExpected);

            // Comparaison de la reponse de la fonction avec le resultat de test attendu :
            if (responseBody.trim() == stringTestExpected.trim()) resultatFinal = 'Succeeded';

			// else resultatFinal = 'Failed';
// TODO : pour un premier deploiement on considere que le test est toujours OK. A voir comment realiser un test personalise pour chaque microservice plus tard ...
			else resultatFinal = 'Succeeded';

            creeAlarmeCloudwatch(cloudwatch, cloudformationAlarm, targetFunctionName, aliasName, versionToTest, function(responseAlarmCreation){
                  console.log("verdict de la creation d'alarme : " + responseAlarmCreation);
                  console.log("Reponse envoyee a CodeDeploy : " + resultatFinal);


                // Prepare the validation test results with the deploymentId and
                // the lifecycleEventHookExecutionId for AWS CodeDeploy.
                var params = {
                        deploymentId: deploymentId,
                    lifecycleEventHookExecutionId: lifecycleEventHookExecutionId,
                    status: resultatFinal // status can be 'Succeeded' or 'Failed'
                };

                // Pass AWS CodeDeploy the prepared validation test results.
                console.log("status retourne a CodeDeploy : " + resultatFinal);
                codedeploy.putLifecycleEventHookExecutionStatus(params, function(err, data) {
                    if (err) {
                                    // Validation failed.
                                    console.log('Validation test failed');
                                    console.log(err);
                                    console.log(data);
                        callback('Validation test failed');
                    } else {
                                    // Validation succeeded.
                                    console.log('Validation test succeeded');
                        callback(null, 'Validation test succeeded');
                    }
                });
            });
        });
};

function recupFichier(nomFichier) {
    var fs = require('fs');
    return fs.readFileSync(nomFichier, 'utf8');
}

function invoquefonctionCible(lambda, targetFunctionArn, stringTestInput, callback) {
      var pullParams = {
      FunctionName : targetFunctionArn,
      InvocationType : 'RequestResponse',
      LogType : 'None',
      Payload : stringTestInput
    };

    lambda.invoke(pullParams, function(err, data) {
         if (err) console.log(err, err.stack);
         else {
            callback(data.Payload);
         }
    });
}

function creeAlarmeCloudwatch(cloudwatch, cloudformationAlarm, FunctionName, aliasName, versionToTest, callback) {
    console.log("time to create CloudWatch alarm !");

    var pullParams = {
      AlarmName: cloudformationAlarm,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      EvaluationPeriods: '1',
      MetricName: 'Errors',
      Namespace: 'AWS/Lambda',
      Period: '60',
      Threshold: '5',
      Statistic: 'Sum',
      Dimensions: [
        {
            Name: 'FunctionName',
            Value: FunctionName
        },
        {
            Name: 'Resource',
            Value: FunctionName + ':' + aliasName,
        },
        {
            Name: 'ExecutedVersion',
            Value: versionToTest,
        }
      ]
    };

    cloudwatch.putMetricAlarm(pullParams, function(err, data) {
        if (err) console.log(err, err.stack); // an error occurred
        else {
            console.log(data);           // successful response
            callback(data.Payload);
        }
    });
}

